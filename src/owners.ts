// Owner discovery for the hosted keeper: which dreamDEX accounts linked our bot
// key with "Link a bot" (Perps)?
//
// Linking writes operator grants to the OperatorPermissionsRegistry for
// placeOrderFor, cancelOrderFor and reduceOrderFor on every perp pool. We find
// candidates in two places and then ask the chain:
//
//   1. The indexer's OperatorApproval table (operator = our key, selector =
//      placeOrderFor, allowed, not a denial). This holds the whole history.
//   2. The registry's own logs since the hub started, so a fresh link counts even
//      if the indexer is behind. A per-pool grant is emitted as topic0 0x10f87936...
//      with topics (pool, owner, operator) and data (bytes4 selector, bool approved).
//
// A candidate only counts when the pool itself says yes: isOperatorAuthorized(owner,
// operator, placeOrderFor) on that perp pool, the resolved decision the pool
// enforces (global and per-pool grants, denial wins). A revoked grant reads false
// there, so the owner drops out on the next refresh.
//
//   npm run owners                 # list owners linked to the default bot key
//   npm run owners -- 0xOperator   # any other operator

import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { INDEXER } from "./check.js";

export const PLACE_ORDER_FOR = "0x80054449" as const;
export const DEFAULT_BOT = "0x13f05c8e15cC0d7d3abff02C144fb74778018a55";
const RPC = process.env.KEEPER_RPC ?? "https://api.hideki2.infra.testnet.somnia.network";
/** The RPC refuses eth_getLogs over more than 1000 blocks. */
const LOG_CHUNK = 1000;
/** Never scan further back than this on one refresh (about 15 minutes of Hideki blocks). */
const MAX_TAIL = 10_000;

export interface Owner {
  address: `0x${string}`;
  /** Perp pools (lowercase) where the pool authorises our key to placeOrderFor. */
  pools: Set<string>;
  /** Every check for this owner failed (RPC error or timeout), so we do not know.
   *  Not a "no": the hub keeps an account it already guards instead of dropping it. */
  unsure?: boolean;
}

export interface PerpPool {
  symbol: string;
  pool: `0x${string}`;
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

const topicOf = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrOf = (t: string) => ("0x" + t.slice(-40)) as `0x${string}`;

/** Indexer: every user who ever granted placeOrderFor to `operator` and has not flipped it off there. */
export async function indexerCandidates(operator: string): Promise<string[]> {
  const users = new Set<string>();
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const query = `{ OperatorApproval(where: {operator: {_eq: "${operator.toLowerCase()}"}, selector: {_eq: "${PLACE_ORDER_FOR}"}, allowed: {_eq: true}, isDenial: {_eq: false}}, limit: ${page}, offset: ${offset}, order_by: {id: asc}) { user } }`;
    const res = await fetch(INDEXER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const j: any = await res.json();
    if (j.errors) throw new Error(`indexer: ${JSON.stringify(j.errors).slice(0, 200)}`);
    const rows: any[] = j.data?.OperatorApproval ?? [];
    for (const r of rows) users.add(String(r.user).toLowerCase());
    if (rows.length < page) break;
  }
  return [...users];
}

/**
 * Registry logs in (fromBlock, toBlock]: any log that names `operator` in a topic.
 * The owner is the topic right before it (pool, owner, operator for a per-pool
 * grant). A wrong guess costs nothing: every candidate is confirmed on chain.
 */
export async function logCandidates(registry: string, operator: string, fromBlock: number, toBlock: number): Promise<string[]> {
  const op = topicOf(operator);
  const users = new Set<string>();
  for (let from = Math.max(fromBlock + 1, toBlock - MAX_TAIL); from <= toBlock; from += LOG_CHUNK) {
    const to = Math.min(toBlock, from + LOG_CHUNK - 1);
    const logs: any[] = await rpc("eth_getLogs", [{ address: registry, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
    for (const l of logs) {
      const i = (l.topics as string[]).findIndex((t, k) => k > 0 && t.toLowerCase() === op);
      if (i > 1) users.add(addrOf(l.topics[i - 1]).toLowerCase());
    }
  }
  return [...users];
}

export async function headBlock(): Promise<number> {
  return Number(await rpc("eth_blockNumber", []));
}

export async function perpPools(client: SomniaMarkets): Promise<PerpPool[]> {
  const rows: any[] = await (client.client as any).listPerpMarkets();
  return rows.map((r) => ({ symbol: `${r.baseSymbol}-PERP`, pool: r.poolAddress as `0x${string}` }));
}

/** The registry the perp pools consult (one on Hideki today; deduplicated in case that changes). */
export async function registriesOf(client: SomniaMarkets, pools: PerpPool[]): Promise<string[]> {
  const set = new Set<string>();
  for (const p of pools) {
    const r = await client.client.getOperatorPermissionsRegistry(p.pool).catch(() => null);
    if (r) set.add(r.toLowerCase());
  }
  return [...set];
}

/** True when the pool lets `operator` call placeOrderFor for `owner` right now. */
export async function canPlaceFor(client: SomniaMarkets, pool: string, owner: string, operator: string): Promise<boolean> {
  return client.client.isOperatorAuthorized({
    pool: pool as `0x${string}`,
    owner: owner as `0x${string}`,
    operator: operator as `0x${string}`,
    selector: PLACE_ORDER_FOR,
  });
}

/** Ask every perp pool. An owner with no pool saying yes is not returned. */
export async function confirmOwners(client: SomniaMarkets, candidates: string[], operator: string, pools: PerpPool[]): Promise<Owner[]> {
  const out: Owner[] = [];
  for (const owner of candidates) {
    if (owner.toLowerCase() === operator.toLowerCase()) continue;
    // A failed read is not a "no". On 13 Nov a burst of RPC timeouts made every
    // check fail, the hub took that as "unlinked", dropped the demo account and
    // lost track of a stop that fired a moment later.
    const answers = await Promise.all(
      pools.map((p) => canPlaceFor(client, p.pool, owner, operator).then((v) => v, () => null as boolean | null)),
    );
    const ok = new Set(pools.filter((_, i) => answers[i] === true).map((p) => p.pool.toLowerCase()));
    if (ok.size) out.push({ address: owner as `0x${string}`, pools: ok });
    else if (answers.some((a) => a === null)) out.push({ address: owner as `0x${string}`, pools: ok, unsure: true });
  }
  return out;
}

/** Keeps the log cursor between refreshes, so each refresh only reads new blocks. */
export class OwnerFinder {
  private cursor: number | undefined;
  private registries: string[] | undefined;
  constructor(
    private client: SomniaMarkets,
    readonly operator: string,
  ) {}

  async find(): Promise<{ owners: Owner[]; fromIndexer: number; fromLogs: number; pools: PerpPool[] }> {
    const pools = await perpPools(this.client);
    this.registries ??= await registriesOf(this.client, pools);
    const head = await headBlock();
    const start = this.cursor ?? head - LOG_CHUNK;
    const [idx, logs] = await Promise.all([
      indexerCandidates(this.operator).catch((e) => {
        console.log(`owners: indexer read failed (${String(e?.message ?? e).slice(0, 120)}), using logs only`);
        return [] as string[];
      }),
      Promise.all(this.registries.map((r) => logCandidates(r, this.operator, start, head))).then((a) => a.flat()),
    ]);
    this.cursor = head;
    const candidates = [...new Set([...idx, ...logs])];
    const owners = await confirmOwners(this.client, candidates, this.operator, pools);
    return { owners, fromIndexer: idx.length, fromLogs: logs.length, pools };
  }
}

async function cli(): Promise<void> {
  const operator = process.argv[2] ?? DEFAULT_BOT;
  const client = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: INDEXER, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });
  const pools = await perpPools(client);
  const registries = await registriesOf(client, pools);
  console.log(`operator ${operator} | ${pools.length} perp pools | registry ${registries.join(", ")}`);
  const finder = new OwnerFinder(client, operator);
  const { owners, fromIndexer, fromLogs } = await finder.find();
  console.log(`candidates: ${fromIndexer} from the indexer, ${fromLogs} from the last ${LOG_CHUNK} blocks of registry logs`);
  // Cross-check the raw registry slots too, so the answer does not rest on one read.
  const raw = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER,
    addresses: { ...SOMNIA_HIDEKI_TESTNET_ADDRESSES, operatorPermissionsRegistry: registries[0] as `0x${string}` } as any,
  });
  for (const o of owners.filter((x) => !x.unsure)) {
    const first = [...o.pools][0] as `0x${string}`;
    const perPool = await raw.client.isApprovedForPool({ pool: first, owner: o.address, operator: operator as `0x${string}`, selector: PLACE_ORDER_FOR });
    const global = await raw.client.isGloballyApproved({ owner: o.address, operator: operator as `0x${string}`, selector: PLACE_ORDER_FOR });
    const names = pools.filter((p) => o.pools.has(p.pool.toLowerCase())).map((p) => p.symbol);
    console.log(`${o.address}: isOperatorAuthorized on ${o.pools.size}/${pools.length} pools (${names.join(" ")}) | isApprovedForPool ${perPool} | isGloballyApproved ${global}`);
  }
  const unsure = owners.filter((x) => x.unsure).length;
  console.log(`${owners.length - unsure} owner(s) linked to ${operator}${unsure ? `, ${unsure} not checked (RPC errors)` : ""}`);
}

if (process.argv[1] && /owners\.(ts|js)$/.test(process.argv[1])) {
  cli().then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
