// Public status of the hosted keeper, for the page: how many accounts it guards
// today and every close it has made. Read-only, no keys. Run by the daily Action.
//
//   npm run status -- docs/keeper-status.json
//
// Guarded accounts: owners that linked the bot key, each confirmed with
// isOperatorAuthorized on the perp pools (same check the hub makes, src/owners.ts).
// Only the count is written, plus our own demo account, which is public anyway.
//
// Closes: successful placeOrderFor transactions sent by the bot key, read from the
// Somnia Tokyo explorer. Since KEEPER_SINCE the key is used by the keeper and the hub
// only, so each of them is a close. Earlier placeOrderFor calls from the same key were
// our own SDK tests for the feedback reports and are left out.

import { writeFileSync } from "node:fs";
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { INDEXER } from "./check.js";
import { DEFAULT_BOT, PLACE_ORDER_FOR, confirmOwners, indexerCandidates, perpPools } from "./owners.js";

const EXPLORER = "https://explorer.testnet.somnia.network/tokyo";
/** The keeper went live on 22 Oct 2026 at about 19:30 UTC; the first close followed at 19:34:38. */
const KEEPER_SINCE = "2026-10-22T19:30:00Z";
const DEMO_OWNER = "0x84326a92162ece92ed257a31073fdd3a6599bf21";

export interface KeeperStatus {
  time: string;
  bot: string;
  guardedAccounts: number;
  demoAccountGuarded: boolean;
  closes: { time: string; market: string; tx: string }[];
}

async function botTransactions(bot: string): Promise<any[]> {
  const out: any[] = [];
  let params = "";
  for (let page = 0; page < 20; page++) {
    const res = await fetch(`${EXPLORER}/api/v2/addresses/${bot}/transactions${params}`);
    if (!res.ok) throw new Error(`explorer: HTTP ${res.status}`);
    const j: any = await res.json();
    out.push(...(j.items ?? []));
    if (!j.next_page_params) break;
    params = "?" + new URLSearchParams(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)])).toString();
  }
  return out;
}

export async function keeperStatus(bot = DEFAULT_BOT): Promise<KeeperStatus> {
  const client = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: INDEXER, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });
  const pools = await perpPools(client);
  const owners = await confirmOwners(client, await indexerCandidates(bot), bot, pools);
  const symbolOf = new Map(pools.map((p) => [p.pool.toLowerCase(), p.symbol]));
  const txs = await botTransactions(bot);
  const closes = txs
    .filter((t) => t.result === "success" && String(t.method ?? "").toLowerCase() === PLACE_ORDER_FOR && t.timestamp >= KEEPER_SINCE)
    .map((t) => ({
      time: String(t.timestamp).slice(0, 19) + "Z",
      market: symbolOf.get(String(t.to?.hash ?? "").toLowerCase()) ?? "perp",
      tx: String(t.hash),
    }))
    .sort((a, b) => b.time.localeCompare(a.time));
  return {
    time: new Date().toISOString().slice(0, 19) + "Z",
    bot,
    guardedAccounts: owners.length,
    demoAccountGuarded: owners.some((o) => o.address.toLowerCase() === DEMO_OWNER),
    closes,
  };
}

if (process.argv[1] && /status\.(ts|js)$/.test(process.argv[1])) {
  const file = process.argv[2];
  keeperStatus().then(
    (s) => {
      console.log(`${s.guardedAccounts} account(s) guarded, ${s.closes.length} close(s): ${s.closes.map((c) => `${c.time} ${c.market}`).join(", ")}`);
      if (file) writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
      process.exit(0);
    },
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
