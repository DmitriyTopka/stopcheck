// npm run check -- <address>          check one account
// npm run check -- --scan [limit]     check every account that has a pending stop
//
// Scan options (all optional):
//   --json <file>         write network totals to <file> (no addresses in it) and
//                         append the same object to scan-history.json next to it
//   --history <file>      history file to append to instead (keeps the last 60)
//   --budget <seconds>    stop checking new accounts after this long; the totals
//                         then say how many accounts were actually read
//   --concurrency <n>     accounts read in parallel (default 4)
// With --json the per-account lines are not printed, so a public CI log carries
// no addresses either.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, http } from "viem";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { checkAccount, createClient, type Report } from "./check.js";

function print(r: Report): void {
  console.log(`\n${r.account}  (${r.checkedAt})`);
  for (const p of r.positions) {
    const legs = p.legs.map((l) => `${l.kind} ${l.triggerPrice} x ${l.wholePosition ? "whole" : l.quantity}`).join(", ");
    console.log(`  ${p.symbol} ${p.side} ${p.size} @ ${p.entry} | TP ${(p.tpCovered * 100).toFixed(1)}% SL ${(p.slCovered * 100).toFixed(1)}% | ${legs || "no stops"}`);
  }
  for (const i of r.idle) console.log(`  ${i.symbol} ${i.state}: ${i.legs.length} stop(s), ${i.restingOrders} resting order(s)`);
  console.log(`  STT held by stops ${r.sttHeld.toFixed(2)}, claimable ${r.sttClaimable.toFixed(2)}`);
  for (const p of r.problems) console.log(`  ! ${p}`);
  if (!r.problems.length) console.log("  ok: nothing to fix");
}

/** Network totals written to docs/scan-latest.json. Aggregates only, no account addresses. */
export interface ScanSummary {
  time: string;
  block: number | null;
  /** Pending perp stops in the indexer and the distinct accounts that own them. */
  pendingStops: number;
  accountsWithPendingStops: number;
  /** Accounts actually read from the chain this run (limit, time budget and failures). */
  accountsScanned: number;
  readFailures: number;
  accountsWithPosition: number;
  /** Accounts with a stop loss that closes only part of an open position. */
  partlyCovered: number;
  /** Entry value of the part those stop losses leave open, in USD. */
  uncoveredNotionalUsd: number;
  /** Accounts with an open position and no stop loss on it. */
  noStopLoss: number;
  /** Accounts holding stops with no position and no resting order behind them. */
  orphanAccounts: number;
  orphanStops: number;
  /** Stops that wait for a resting limit order to fill (not a problem by themselves). */
  waitingStops: number;
  sttHeldByStops: number;
  sttToClaim: number;
  accountsWithSttToClaim: number;
  /** Report 019: pending stops created in the last 7 days, and how many store a fixed size. */
  stopsCreated7d: number;
  fixedSizeStops7d: number;
}

const round = (x: number, d: number) => Number(x.toFixed(d));

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Every pending perp stop, page by page (a single page used to stop at 1000). */
async function listAllPending(c: any): Promise<any[]> {
  const page = 1000;
  const all: any[] = [];
  for (let offset = 0; offset < 20_000; offset += page) {
    const rows: any[] = await c.listPerpStopOrders({ limit: page, offset });
    all.push(...rows);
    if (rows.length < page) break;
  }
  return all;
}

async function scan(args: string[]): Promise<void> {
  const limit = args[1] && !args[1].startsWith("--") ? Number(args[1]) : 50;
  const jsonPath = flag(args, "--json");
  const budgetMs = Number(flag(args, "--budget") ?? 0) * 1000;
  const workers = Math.max(1, Number(flag(args, "--concurrency") ?? 4));
  const quiet = Boolean(jsonPath);
  const started = Date.now();

  const client = createClient();
  const c = client.client as any;
  const pending = await listAllPending(c);
  const allOwners = [...new Set(pending.map((s: any) => String(s.owner).toLowerCase()))];
  const owners = allOwners.slice(0, limit);
  const markets = new Set(pending.map((s: any) => s.market?.baseSymbol));
  console.log(`markets with pending stops: ${[...markets].join(", ")}`);
  console.log(`${pending.length} pending stops, ${allOwners.length} owners, checking up to ${owners.length}`);

  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86_400;
  const recent = pending.filter((s: any) => Number(s.createdAt) >= weekAgo);

  const tally = { owners: owners.length, withPosition: 0, underCoveredSL: 0, noSL: 0, idle: 0, claimable: 0 };
  const sum: ScanSummary = {
    time: "",
    block: null,
    pendingStops: pending.length,
    accountsWithPendingStops: allOwners.length,
    accountsScanned: 0,
    readFailures: 0,
    accountsWithPosition: 0,
    partlyCovered: 0,
    uncoveredNotionalUsd: 0,
    noStopLoss: 0,
    orphanAccounts: 0,
    orphanStops: 0,
    waitingStops: 0,
    sttHeldByStops: 0,
    sttToClaim: 0,
    accountsWithSttToClaim: 0,
    stopsCreated7d: recent.length,
    fixedSizeStops7d: recent.filter((s: any) => String(s.quantity) !== "0").length,
  };

  let next = 0;
  let outOfTime = false;
  const worker = async () => {
    while (next < owners.length) {
      if (budgetMs && Date.now() - started > budgetMs) {
        outOfTime = true;
        return;
      }
      const o = owners[next++];
      try {
        const r = await checkAccount(o, client);
        if (!quiet) print(r);
        sum.accountsScanned++;
        if (r.positions.length) tally.withPosition++;
        const partial = r.positions.filter((p) => p.legs.some((l) => l.kind === "SL") && p.slCovered < 1);
        if (partial.length) tally.underCoveredSL++;
        sum.uncoveredNotionalUsd += partial.reduce((a, p) => a + p.size * (1 - p.slCovered) * p.entry, 0);
        if (r.positions.some((p) => !p.legs.some((l) => l.kind === "SL"))) tally.noSL++;
        if (r.idle.length) tally.idle++;
        if (r.sttClaimable > 0) tally.claimable++;
        const orphans = r.idle.filter((i) => i.state === "orphan");
        if (orphans.length) sum.orphanAccounts++;
        sum.orphanStops += orphans.reduce((a, i) => a + i.legs.length, 0);
        sum.waitingStops += r.idle.filter((i) => i.state === "waiting").reduce((a, i) => a + i.legs.length, 0);
        sum.sttHeldByStops += r.sttHeld;
        sum.sttToClaim += r.sttClaimable;
      } catch (e: any) {
        sum.readFailures++;
        if (!quiet) console.log(`\n${o}  read failed: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));

  console.log("\nSUMMARY", JSON.stringify(tally));
  if (outOfTime) console.log(`time budget reached: ${sum.accountsScanned} of ${owners.length} accounts read`);
  console.log(`took ${Math.round((Date.now() - started) / 1000)} s`);
  if (!jsonPath) return;

  // A run that could read almost nothing (RPC down) must not replace yesterday's numbers.
  if (sum.accountsScanned < Math.min(20, owners.length) || sum.readFailures > sum.accountsScanned) {
    console.error(`not writing ${jsonPath}: ${sum.accountsScanned} accounts read, ${sum.readFailures} failed`);
    process.exit(2);
  }

  const block = await createPublicClient({ chain: hidekiTestnet, transport: http() })
    .getBlockNumber()
    .catch(() => null);
  const out: ScanSummary = {
    ...sum,
    time: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    block: block === null ? null : Number(block),
    accountsWithPosition: tally.withPosition,
    partlyCovered: tally.underCoveredSL,
    noStopLoss: tally.noSL,
    accountsWithSttToClaim: tally.claimable,
    uncoveredNotionalUsd: round(sum.uncoveredNotionalUsd, 2),
    sttHeldByStops: round(sum.sttHeldByStops, 2),
    sttToClaim: round(sum.sttToClaim, 2),
  };

  const historyPath = flag(args, "--history") ?? join(dirname(jsonPath), "scan-history.json");
  let history: ScanSummary[] = [];
  try {
    const parsed = JSON.parse(readFileSync(historyPath, "utf8"));
    if (Array.isArray(parsed)) history = parsed;
  } catch {
    // first run, or an unreadable file: start a fresh history
  }
  history.push(out);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(out, null, 2) + "\n");
  writeFileSync(historyPath, JSON.stringify(history.slice(-60), null, 2) + "\n");
  console.log(`wrote ${jsonPath} and ${historyPath} (${Math.min(history.length, 60)} entries)`);
  console.log(JSON.stringify(out));
}

const args = process.argv.slice(2);

if (args[0] === "--scan") {
  await scan(args);
} else {
  print(await checkAccount(args[0] ?? "0x84326A92162Ece92ed257A31073fDd3a6599BF21", createClient()));
}
process.exit(0);
