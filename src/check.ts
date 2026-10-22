// StopCheck: does an account's TP/SL actually cover its dreamDEX perp positions?
//
// Three traps found on Hideki testnet (feedback reports 019, 020, 022):
//   - a TP/SL set as "Entire" stores a fixed size, so adding to the position
//     leaves part of it unprotected;
//   - cancelling a limit order leaves its attached TP/SL armed, holding STT and
//     later acting on an unrelated position;
//   - when one leg of a linked pair fills, the other leg's STT is credited to
//     unclaimedSomi instead of being refunded.
//
// Everything here is a read. Positions and stop sizes come from the chain; the
// indexer is only used to find which markets and stop ids to look at.

import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

export const INDEXER = "https://hideki-dev.smk.somnia.host/v1/graphql";

const TRIGGER_GTE = 0;
const TRIGGER_LTE = 1;

export type Side = "long" | "short";

export interface StopLeg {
  id: string;
  kind: "TP" | "SL" | "wrong side";
  triggerPrice: number;
  /** Base units the leg closes; 0 means "the whole position when it fires". */
  quantity: number;
  wholePosition: boolean;
  linkedTo: string | null;
  sttHeld: number;
}

export interface PositionCheck {
  symbol: string;
  side: Side;
  size: number;
  entry: number;
  tpCovered: number;
  slCovered: number;
  legs: StopLeg[];
}

export interface IdleStops {
  symbol: string;
  /** "waiting" when a resting order could still open a position the stops would close. */
  state: "orphan" | "waiting";
  restingOrders: number;
  legs: StopLeg[];
}

export interface Report {
  account: string;
  checkedAt: string;
  positions: PositionCheck[];
  idle: IdleStops[];
  unclaimed: { symbol: string; stt: number }[];
  sttHeld: number;
  sttClaimable: number;
  problems: string[];
}

interface Market {
  symbol: string;
  pool: `0x${string}`;
  marginBank: `0x${string}`;
  registry: `0x${string}` | null;
  baseDecimals: number;
}

export function createClient(): SomniaMarkets {
  return new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: INDEXER, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });
}

// Rounded to 10 significant digits so 6975e-1 does not print as 697.5000000000001.
const human = (raw: bigint | string | number, decimals: number) => Number((Number(BigInt(raw)) / 10 ** decimals).toPrecision(10));
// Never round a partial cover up to 100% or a small one down to 0%: 99.6% printed
// as "100%" next to "the rest has no stop" reads as a contradiction.
const pct = (x: number) => {
  const v = x * 100;
  if (v >= 100) return "100%";
  if (v > 0 && v < 1) return `${v.toFixed(1)}%`;
  return `${Math.floor(v)}%`;
};

function classify(isBid: boolean, operator: number, side: Side | null): StopLeg["kind"] {
  // Closing a long sells, closing a short buys. A leg on the other side cannot
  // reduce this position: it either drops on fire or, with no position, does nothing.
  if (side === null) return operator === TRIGGER_GTE ? (isBid ? "SL" : "TP") : isBid ? "TP" : "SL";
  const closes = side === "long" ? !isBid : isBid;
  if (!closes) return "wrong side";
  if (side === "long") return operator === TRIGGER_GTE ? "TP" : "SL";
  return operator === TRIGGER_LTE ? "TP" : "SL";
}

function covered(legs: StopLeg[], kind: "TP" | "SL", size: number): number {
  if (size <= 0) return 0;
  let sum = 0;
  for (const leg of legs) {
    if (leg.kind !== kind) continue;
    if (leg.wholePosition) return 1;
    sum += leg.quantity;
  }
  return Math.min(1, sum / size);
}

export async function checkAccount(account: string, client: SomniaMarkets = createClient()): Promise<Report> {
  const c = client.client as any;
  const addr = account as `0x${string}`;

  const rows: any[] = await c.listPerpMarkets();
  const markets = new Map<string, Market>();
  for (const r of rows) {
    markets.set(String(r.poolAddress).toLowerCase(), {
      symbol: `${r.baseSymbol}-PERP`,
      pool: r.poolAddress,
      marginBank: r.marginBank,
      registry: r.stopRegistry ?? null,
      baseDecimals: Number(r.baseDecimals),
    });
  }

  // Pending stops, then their exact on-chain state (quantity, sibling, STT paid).
  const pending: any[] = await c.listPerpStopOrders({ account: addr });
  const reads: any[] = pending.length
    ? await c.getPerpStopOrders(pending.map((s: any) => ({ registry: s.registry, orderId: s.orderIdRaw })))
    : [];
  const stopsByPool = new Map<string, { isBid: boolean; op: number; leg: StopLeg }[]>();
  pending.forEach((s: any, i: number) => {
    const read = reads[i];
    if (!read || read.status !== "present") return;
    const o = read.order;
    const pool = String(s.market?.poolAddress ?? "").toLowerCase();
    const m = markets.get(pool);
    if (!m) return;
    const q = BigInt(o.quantity);
    const list = stopsByPool.get(pool) ?? [];
    list.push({
      isBid: Boolean(o.isBid),
      op: Number(o.triggerOperator),
      leg: {
        id: String(s.orderIdRaw),
        kind: "TP",
        triggerPrice: human(o.triggerPrice, 18),
        quantity: human(q, m.baseDecimals),
        wholePosition: q === 0n,
        linkedTo: BigInt(o.siblingOrderId) === 0n ? null : String(o.siblingOrderId),
        sttHeld: human(o.somiPaid, 18),
      },
    });
    stopsByPool.set(pool, list);
  });

  // Positions: the indexer says where to look, the chain says how big.
  const indexed: any[] = await c.listPerpPositions(addr).catch(() => []);
  const pools = new Set<string>([...indexed.map((p: any) => String(p.pool ?? p.poolAddress ?? "").toLowerCase()), ...stopsByPool.keys()]);
  pools.delete("");
  const sizes = new Map<string, { size: bigint; entry: bigint }>();
  await Promise.all(
    [...pools].map(async (pool) => {
      const m = markets.get(pool);
      if (!m) return;
      const p = await c.getPerpPosition({ marginBank: m.marginBank, account: addr, pool: m.pool });
      sizes.set(pool, { size: BigInt(p.size), entry: BigInt(p.avgEntryPrice) });
    }),
  );

  // Resting orders tell a stop that waits for its entry apart from a true orphan.
  const idlePools = [...stopsByPool.keys()].filter((p) => (sizes.get(p)?.size ?? 0n) === 0n);
  const resting = new Map<string, number>();
  if (idlePools.length) {
    const open: any = await c.getOpenOrdersOnchain(idlePools.map((p) => markets.get(p)!.pool), addr).catch(() => null);
    for (const o of open?.orders ?? []) {
      const k = String(o.pool).toLowerCase();
      resting.set(k, (resting.get(k) ?? 0) + 1);
    }
  }

  const report: Report = {
    account: addr,
    checkedAt: new Date().toISOString(),
    positions: [],
    idle: [],
    unclaimed: [],
    sttHeld: 0,
    sttClaimable: 0,
    problems: [],
  };

  for (const pool of pools) {
    const m = markets.get(pool)!;
    const pos = sizes.get(pool);
    const stops = stopsByPool.get(pool) ?? [];
    const signed = pos ? human(pos.size, m.baseDecimals) : 0;
    const side: Side | null = signed > 0 ? "long" : signed < 0 ? "short" : null;
    const legs = stops.map((s) => ({ ...s.leg, kind: classify(s.isBid, s.op, side) }));
    report.sttHeld += legs.reduce((a, l) => a + l.sttHeld, 0);

    if (side) {
      const size = Math.abs(signed);
      const check: PositionCheck = {
        symbol: m.symbol,
        side,
        size,
        entry: human(pos!.entry, 18),
        tpCovered: covered(legs, "TP", size),
        slCovered: covered(legs, "SL", size),
        legs,
      };
      report.positions.push(check);
      if (legs.some((l) => l.kind === "SL") && check.slCovered < 1) {
        report.problems.push(`${m.symbol}: stop loss covers ${pct(check.slCovered)} of the ${size} ${side}; the rest has no stop.`);
      }
      if (legs.some((l) => l.kind === "TP") && check.tpCovered < 1) {
        report.problems.push(`${m.symbol}: take profit covers ${pct(check.tpCovered)} of the ${size} ${side}.`);
      }
      if (!legs.some((l) => l.kind === "SL")) report.problems.push(`${m.symbol}: ${side} ${size} has no stop loss.`);
      const wrong = legs.filter((l) => l.kind === "wrong side");
      if (wrong.length) report.problems.push(`${m.symbol}: ${wrong.length} stop(s) are on the wrong side for a ${side} and cannot reduce it.`);
    } else if (legs.length) {
      const n = resting.get(pool) ?? 0;
      report.idle.push({ symbol: m.symbol, state: n > 0 ? "waiting" : "orphan", restingOrders: n, legs });
      const held = legs.reduce((a, l) => a + l.sttHeld, 0);
      report.problems.push(
        n > 0
          ? `${m.symbol}: ${legs.length} stop(s) wait for a resting order to fill (${held.toFixed(2)} STT held). If you cancel that order, cancel these too.`
          : `${m.symbol}: ${legs.length} stop(s) with no position and no order (${held.toFixed(2)} STT held). They would close a future position; cancel them.`,
      );
    }
  }

  // STT credited instead of refunded (linked fills, registry wind-down).
  const registries = [...markets.values()].filter((m) => m.registry);
  await Promise.all(
    registries.map(async (m) => {
      const owed = await c.getUnclaimedPerpStopSomi({ registry: m.registry, account: addr }).catch(() => 0n);
      const stt = human(owed, 18);
      if (stt > 0) report.unclaimed.push({ symbol: m.symbol, stt });
    }),
  );
  report.sttClaimable = report.unclaimed.reduce((a, u) => a + u.stt, 0);
  if (report.sttClaimable > 0) {
    report.problems.push(`${report.sttClaimable.toFixed(2)} STT of trigger fees is waiting to be claimed (press Claim in the app's Balances tab).`);
  }
  return report;
}
