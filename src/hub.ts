// Hosted gap keeper: guards every dreamDEX account that linked our bot key with
// "Link a bot" (Perps), not just one.
//
// Every HUB_REFRESH_MS it refreshes the list of accounts whose perp pools let the
// key call placeOrderFor for them (src/owners.ts). Every KEEPER_POLL_MS it runs,
// for each of them, the same cycle the single keeper runs (src/gap.ts): find the
// part of a position the stop loss does not cover, and close only that part once
// the stop price is crossed or the stop has fired.
//
// Safe by default: nothing is sent unless DRY_RUN=false. Before every live close
// the pool is asked again whether the grant still stands, and two gas caps apply:
// one per account and one for the whole hub. One account failing never stops
// the others.
//
//   npm run hub                                          # dry run, no key needed
//   PRIVATE_KEY=<bot key> DRY_RUN=false npm run hub      # live

import { createExchange, envNum, loadEnv, onStop, shutdown, sleep, type PerpContext } from "@dreamdex-bot-kit/perp-core";
import { getAddress } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createClient, listAllPerpMarkets } from "./check.js";
import { gapStep, newOwnerState, type OwnerState } from "./gap.js";
import { DEFAULT_BOT, OwnerFinder, canPlaceFor } from "./owners.js";
import { startWake, type Wake } from "./wake.js";

loadEnv();
const POLL_MS = envNum("KEEPER_POLL_MS", 10_000);
const REFRESH_MS = envNum("HUB_REFRESH_MS", 60_000);
const COOLDOWN_MS = envNum("KEEPER_COOLDOWN_MS", 30_000);
// The hub stops sending for one account once the key has spent this much on it,
// and for every account once it has spent the global amount since start. It
// keeps watching and logging either way, so a restart does not reset the count
// behind your back.
const OWNER_GAS_CAP_STT = envNum("HUB_OWNER_GAS_CAP_STT", 0.1);
const GAS_CAP_STT = envNum("KEEPER_GAS_CAP_STT", 1);
const MAX_OWNERS = envNum("HUB_MAX_OWNERS", 50);
// Accounts guarded before anyone else and outside the shared budget, so strangers
// who link the key cannot use up the gas or the slots the demo account needs.
const PRIORITY = new Set(
  (process.env.HUB_PRIORITY_OWNERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);
const PRIORITY_GAS_CAP_STT = envNum("HUB_PRIORITY_GAS_CAP_STT", 0.5);
// Gas spent per account, kept on disk and keyed by address, so it survives an
// account being dropped and re-added and a restart of the hub.
const SPEND_FILE = process.env.HUB_SPEND_FILE ?? "state/hub-spend.json";
function loadSpend(): Record<string, number> {
  try {
    return existsSync(SPEND_FILE) ? JSON.parse(readFileSync(SPEND_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}
function saveSpend(s: Record<string, number>): void {
  mkdirSync(dirname(SPEND_FILE), { recursive: true });
  writeFileSync(SPEND_FILE, JSON.stringify(s, null, 2));
}
const RPC = process.env.KEEPER_RPC ?? "https://api.hideki2.infra.testnet.somnia.network";

async function balanceStt(address: string): Promise<number> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  return Number(BigInt((await res.json()).result)) / 1e18;
}

const short = (a: string) => `${a.slice(0, 6)}..${a.slice(-4)}`;

interface Guarded {
  owner: `0x${string}`;
  tag: string;
  ctx: PerpContext;
  state: OwnerState;
  spent: number;
  /** Set after a cycle threw: the account is skipped until then. */
  backoffUntil: number;
  /** Refreshes in a row that confirmed the grant is gone. */
  misses: number;
}

/** An account is dropped only after this many refreshes in a row confirm the grant is gone. */
const DROP_AFTER = 3;

/**
 * A perp-core context that reads as `owner` and, when a key is loaded, sends for
 * it through placeOrderFor. createExchange takes the owner from OWNER_ADDRESS,
 * so it is set for this one synchronous call and put back.
 */
function contextFor(owner: string, withSigner: boolean): PerpContext {
  const prev = process.env.OWNER_ADDRESS;
  process.env.OWNER_ADDRESS = owner;
  try {
    return createExchange({ withSigner });
  } finally {
    if (prev === undefined) delete process.env.OWNER_ADDRESS;
    else process.env.OWNER_ADDRESS = prev;
  }
}

async function main(): Promise<void> {
  const live = process.env.DRY_RUN === "false";
  const key = (process.env.PRIVATE_KEY ?? "").trim();
  if (live && !key) throw new Error("DRY_RUN=false needs PRIVATE_KEY: the bot key traders link in the app.");
  const fromKey = key ? privateKeyToAccount(key as `0x${string}`).address : undefined;
  const botEnv = (process.env.BOT_ADDRESS ?? "").trim();
  if (fromKey && botEnv && getAddress(botEnv) !== fromKey) {
    throw new Error(`BOT_ADDRESS ${botEnv} is not the address of PRIVATE_KEY (${fromKey}).`);
  }
  const bot = getAddress(fromKey ?? (botEnv || DEFAULT_BOT));
  const stopped = onStop();
  const client = createClient();
  const finder = new OwnerFinder(client, bot);
  const guarded = new Map<string, Guarded>();
  const startBalance = await balanceStt(bot);
  let capLogged = false;
  const spend = loadSpend();
  const sharedSpent = () =>
    Object.entries(spend).filter(([k]) => !PRIORITY.has(k)).reduce((a, [, v]) => a + v, 0);
  let lastRefresh = 0;
  // Optional Somnia Reactivity wake-up (HUB_REACTIVITY=1): polling stays as the fallback.
  let wake: Wake | null = null;
  if (process.env.HUB_REACTIVITY === "1") {
    const rows: any[] = await listAllPerpMarkets(client.client as any);
    const sources = [...new Set(rows.flatMap((r) => [r.poolAddress, r.marginBank, r.stopRegistry]).filter(Boolean).map((a) => String(a).toLowerCase()))];
    wake = startWake(sources, () => [...guarded.keys()], (line) => console.log(line));
  }

  console.log(
    `gap keeper hub for bot ${bot} | refresh owners ${REFRESH_MS / 1000}s | poll ${POLL_MS / 1000}s | dry-run ${!live} | ` +
      `gas cap ${OWNER_GAS_CAP_STT} STT per account, ${GAS_CAP_STT} STT total from ${startBalance.toFixed(4)}`,
  );

  async function refresh(): Promise<void> {
    const { owners, fromIndexer, fromLogs, pools } = await finder.find();
    const seen = new Set<string>();
    // Priority accounts first, then the rest in discovery order up to the slot limit.
    const ranked = [...owners].sort(
      (a, b) => Number(PRIORITY.has(b.address.toLowerCase())) - Number(PRIORITY.has(a.address.toLowerCase())),
    );
    for (const o of ranked.slice(0, MAX_OWNERS)) {
      const k = o.address.toLowerCase();
      if (o.unsure) {
        // The grant could not be read this time. Keep an account we already guard
        // (with its memory of uncovered parts); do not add a new one on a guess.
        if (guarded.has(k)) {
          seen.add(k);
          console.log(`${guarded.get(k)!.tag} link check failed (RPC), keeping it`);
        }
        continue;
      }
      seen.add(k);
      const known = guarded.get(k);
      if (known) known.misses = 0;
      if (!known) {
        const owner = getAddress(o.address);
        guarded.set(k, {
          owner,
          tag: `[${short(owner)}]`,
          ctx: contextFor(owner, Boolean(key)),
          state: newOwnerState(),
          spent: spend[k] ?? 0,
          backoffUntil: 0,
          misses: 0,
        });
        console.log(`[${short(owner)}] now guarded: placeOrderFor granted on ${o.pools.size}/${pools.length} perp pools`);
      }
    }
    for (const [k, g] of guarded) {
      if (seen.has(k)) continue;
      // The grant was revoked (or the indexer and the pools both stopped naming it).
      // One refresh is not enough: wait for DROP_AFTER in a row.
      g.misses += 1;
      if (g.misses < DROP_AFTER) {
        console.log(`${g.tag} grant not found (${g.misses}/${DROP_AFTER}), keeping it for now`);
        continue;
      }
      console.log(`${g.tag} no longer linked, dropped`);
      await shutdown(g.ctx);
      guarded.delete(k);
    }
    if (owners.length > MAX_OWNERS) console.log(`owners: ${owners.length} linked, guarding the first ${MAX_OWNERS} (HUB_MAX_OWNERS)`);
    console.log(`owners: ${guarded.size} guarded (${fromIndexer} indexer candidate(s), ${fromLogs} from new registry logs)`);
  }

  while (!stopped()) {
    if (Date.now() - lastRefresh >= REFRESH_MS) {
      try {
        await refresh();
      } catch (e: any) {
        // Keep guarding the last known list; a grant check before every send still applies.
        console.log(`owners: refresh failed, keeping ${guarded.size}: ${String(e?.message ?? e).slice(0, 160)}`);
      }
      lastRefresh = Date.now();
    }

    for (const g of guarded.values()) {
      if (stopped()) break;
      if (Date.now() < g.backoffUntil) continue;
      const log = (line: string) => console.log(`${g.tag} ${line}`);
      let before = 0;
      try {
        await gapStep({
          ctx: g.ctx,
          owner: g.owner,
          state: g.state,
          live,
          cooldownMs: COOLDOWN_MS,
          log,
          beforeSend: async (symbol, pool) => {
            if (!(await canPlaceFor(client, pool, g.owner, bot).catch(() => false))) {
              log(`${symbol}: grant revoked on this pool, not sending`);
              return "skip";
            }
            before = await balanceStt(bot);
            const prio = PRIORITY.has(g.owner.toLowerCase());
            const total = sharedSpent();
            if (!prio && total >= GAS_CAP_STT) {
              if (!capLogged) console.log(`gas cap reached: spent ${total.toFixed(4)} STT on shared accounts, watching only from now on`);
              capLogged = true;
              log(`${symbol}: total gas cap reached, not sending`);
              return "skip";
            }
            if (g.spent >= (prio ? PRIORITY_GAS_CAP_STT : OWNER_GAS_CAP_STT)) {
              log(`${symbol}: account gas cap reached (${g.spent.toFixed(4)} STT), not sending`);
              return "skip";
            }
            return "send";
          },
          afterSend: async () => {
            g.spent += Math.max(0, before - (await balanceStt(bot).catch(() => before - 0.02)));
            spend[g.owner.toLowerCase()] = g.spent;
            saveSpend(spend);
            log(`gas spent on this account so far: ${g.spent.toFixed(4)} STT`);
          },
        });
      } catch (e: any) {
        log(`cycle failed, skipping this account for ${COOLDOWN_MS / 1000}s: ${String(e?.message ?? e).slice(0, 160)}`);
        g.backoffUntil = Date.now() + COOLDOWN_MS;
      }
    }

    if (wake) {
      const woke = await Promise.race([sleep(POLL_MS, stopped).then(() => null), wake.next()]);
      if (woke) console.log(`[${short(woke.owner)}] woken by a Reactivity event at ${new Date(woke.at).toISOString()}`);
    } else {
      await sleep(POLL_MS, stopped);
    }
  }
  wake?.close();
  for (const g of guarded.values()) await shutdown(g.ctx);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
