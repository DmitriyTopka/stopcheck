// Gap keeper: closes the part of a position your stop loss does not cover.
//
// A trading key linked with "Link a bot" cannot arm stops for the account, so
// the keeper cannot fix a short stop by re-arming it. It watches instead. When
// the mark reaches the account's stop-loss trigger and that stop covers only
// part of the position, it closes the uncovered rest with a reduce order sent
// through placeOrderFor (perp-core's closePosition).
//
// Needs a dreamdex-bot-kit checkout next to this repo (see README):
//   PRIVATE_KEY=<linked trading key> OWNER_ADDRESS=<account> NETWORK=hideki \
//   DRY_RUN=false npx tsx src/keeper.ts

import {
  closePosition,
  createExchange,
  envNum,
  liveMark,
  loadEnv,
  onStop,
  requireMarket,
  shutdown,
  sleep,
  tradingKeyCheck,
} from "@dreamdex-bot-kit/perp-core";
import { checkAccount, type PositionCheck } from "./check.js";

loadEnv();
const POLL_MS = envNum("KEEPER_POLL_MS", 10_000);
// After a close, give the chain and the indexer time to show it before acting
// on the same position again.
const COOLDOWN_MS = envNum("KEEPER_COOLDOWN_MS", 30_000);

interface Gap {
  symbol: string;
  side: "long" | "short";
  /** Base units the stop loss does not cover, measured before anything fires. */
  uncovered: number;
  /** The stop-loss trigger that fires first for this side. */
  trigger: number;
}

function gapOf(p: PositionCheck): Gap | undefined {
  const sl = p.legs.filter((l) => l.kind === "SL");
  if (!sl.length || p.slCovered >= 1) return undefined;
  const prices = sl.map((l) => l.triggerPrice);
  // A long is stopped on the way down, so the highest trigger fires first; a short the mirror.
  const trigger = p.side === "long" ? Math.max(...prices) : Math.min(...prices);
  return { symbol: p.symbol, side: p.side, uncovered: p.size * (1 - p.slCovered), trigger };
}

async function main(): Promise<void> {
  const live = process.env.DRY_RUN === "false";
  const ctx = createExchange({ withSigner: true });
  const owner = (ctx.config.owner || ctx.exchange.walletAddress) as `0x${string}`;
  const stopped = onStop();
  const lastAct = new Map<string, number>();
  // Gaps are remembered from the last read where the stop was still armed: once
  // the account's own stop fires, the next read shows no SL at all.
  const known = new Map<string, Gap>();

  console.log(`gap keeper for ${owner} | poll ${POLL_MS / 1000}s | dry-run ${!live}`);

  while (!stopped()) {
    let report;
    try {
      report = await checkAccount(owner, ctx.exchange);
    } catch (e: any) {
      console.log(`read failed, retrying: ${String(e?.message ?? e).slice(0, 160)}`);
      await sleep(POLL_MS, stopped);
      continue;
    }

    const open = new Map(report.positions.map((p) => [p.symbol, p]));
    for (const p of report.positions) {
      const g = gapOf(p);
      if (g) known.set(p.symbol, g);
      else if (p.slCovered >= 1) known.delete(p.symbol);
    }
    for (const sym of [...known.keys()]) if (!open.has(sym)) known.delete(sym);

    for (const g of known.values()) {
      const p = open.get(g.symbol)!;
      const market = await requireMarket(ctx.exchange, g.symbol, { reload: true });
      const mark = await liveMark(ctx.exchange, market);
      if (mark === undefined) {
        console.log(`${g.symbol}: mark unavailable, holding`);
        continue;
      }
      const hit = g.side === "long" ? mark <= g.trigger : mark >= g.trigger;
      console.log(
        `${g.symbol} ${g.side} ${p.size}: stop covers ${Math.round(p.slCovered * 100)}%, ` +
          `${g.uncovered.toPrecision(6)} uncovered | SL ${g.trigger} | mark ${mark}${hit ? " | HIT" : ""}`,
      );
      if (!hit) continue;
      if (Date.now() - (lastAct.get(g.symbol) ?? 0) < COOLDOWN_MS) continue;

      // Close the uncovered amount, capped by what is open now: if the account's
      // own stop already fired, what is left IS the uncovered part.
      const fraction = Math.min(1, g.uncovered / p.size);
      lastAct.set(g.symbol, Date.now());
      if (!live) {
        console.log(`[dry-run] would close ${(fraction * 100).toFixed(1)}% of ${g.symbol} (${(p.size * fraction).toPrecision(6)})`);
        continue;
      }
      const res = await closePosition(ctx, market, owner, { fraction, label: "gap keeper" });
      console.log(`${g.symbol}: gap close sent=${res.sent} filled=${res.filled}`);
      if (res.sent) known.delete(g.symbol);
    }

    if (!known.size) console.log(`nothing uncovered (${report.positions.length} position(s))`);
    await sleep(POLL_MS, stopped);
  }
  await shutdown(ctx);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
