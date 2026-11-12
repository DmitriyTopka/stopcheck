// One keeper cycle for one account, shared by the single-account keeper
// (src/keeper.ts) and the hosted hub (src/hub.ts).
//
// Read the account, remember every position whose stop loss covers only part of
// it, and when the mark crosses that stop (or the stop has fired) close the
// uncovered rest with a reduce order sent through placeOrderFor.

import { closePosition, liveMark, requireMarket, type PerpContext } from "@dreamdex-bot-kit/perp-core";
import { checkAccount, type PositionCheck } from "./check.js";

export interface Gap {
  symbol: string;
  side: "long" | "short";
  /** Base units the stop loss does not cover, measured before anything fires. */
  uncovered: number;
  /** The stop-loss trigger that fires first for this side. */
  trigger: number;
  /** Ids of the stop-loss legs, to tell a fired stop from a cancelled one. */
  slIds: string[];
}

export function gapOf(p: PositionCheck): Gap | undefined {
  const sl = p.legs.filter((l) => l.kind === "SL");
  if (!sl.length || p.slCovered >= 1) return undefined;
  const prices = sl.map((l) => l.triggerPrice);
  // A long is stopped on the way down, so the highest trigger fires first; a short the mirror.
  const trigger = p.side === "long" ? Math.max(...prices) : Math.min(...prices);
  return { symbol: p.symbol, side: p.side, uncovered: p.size * (1 - p.slCovered), trigger, slIds: sl.map((l) => l.id) };
}

/** What the keeper remembers about one account between cycles. */
export interface OwnerState {
  /**
   * Gaps are remembered from the last read where the stop was still armed: once
   * the account's own stop fires, the next read shows no SL at all.
   */
  known: Map<string, Gap>;
  /** Last close per symbol, for the cooldown. */
  lastAct: Map<string, number>;
}

export function newOwnerState(): OwnerState {
  return { known: new Map(), lastAct: new Map() };
}

export interface StepOptions {
  /** A context whose exchange reads as `owner` and whose trading key sends for it. */
  ctx: PerpContext;
  owner: `0x${string}`;
  state: OwnerState;
  live: boolean;
  /** After a close, give the chain and the indexer time to show it before acting on the same position again. */
  cooldownMs: number;
  log?: (line: string) => void;
  /**
   * Asked right before a live close. "send" goes ahead, "skip" leaves this
   * position alone this cycle, "stop" ends the step at once with "stop".
   */
  beforeSend?: (symbol: string, pool: `0x${string}`) => Promise<"send" | "skip" | "stop">;
  /** Told after a live close attempt returned. */
  afterSend?: (symbol: string, sent: boolean) => Promise<void>;
}

export type StepResult = "ok" | "read-failed" | "stop";

/**
 * One cycle for one account. A read failure is logged and reported, not thrown.
 * Anything else that throws (market lookup, the close itself) propagates.
 */
export async function gapStep(o: StepOptions): Promise<StepResult> {
  const log = o.log ?? ((line: string) => console.log(line));
  const { ctx, owner } = o;
  const { known, lastAct } = o.state;

  let report;
  try {
    // perp-core brings its own copy of the markets SDK (0.31), check.ts is typed
    // against ours (0.32.1). The reads checkAccount makes exist in both.
    report = await checkAccount(owner, ctx.exchange as unknown as Parameters<typeof checkAccount>[1]);
  } catch (e: any) {
    log(`read failed, retrying: ${String(e?.message ?? e).slice(0, 160)}`);
    return "read-failed";
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
      log(`${g.symbol}: mark unavailable, holding`);
      continue;
    }
    // The account's own stop fires the moment the mark crosses; the keeper only
    // looks every few seconds and the mark can bounce back in between. So a stop
    // loss that vanished is looked up: TRIGGERED means close the rest whatever
    // the mark says now, CANCELLED means the trader removed it on purpose.
    let fired = false;
    if (!p.legs.some((l) => l.kind === "SL")) {
      const done: any[] = await (ctx.exchange.client as any)
        .listPerpStopOrders({ account: owner, status: "TRIGGERED" })
        .catch(() => []);
      fired = done.some((s) => g.slIds.includes(String(s.orderIdRaw)));
      if (!fired) {
        const gone: any[] = await (ctx.exchange.client as any)
          .listPerpStopOrders({ account: owner, status: "CANCELLED" })
          .catch(() => []);
        if (gone.some((s) => g.slIds.includes(String(s.orderIdRaw)) && s.cancelReason === "Owner")) {
          log(`${g.symbol}: stop loss was cancelled by the trader, leaving the position alone`);
          known.delete(g.symbol);
        } else {
          // Neither state indexed yet: the indexer trails the chain by a few seconds.
          log(`${g.symbol}: stop loss vanished, waiting for the indexer to say why`);
        }
        continue;
      }
    }
    const crossed = g.side === "long" ? mark <= g.trigger : mark >= g.trigger;
    const hit = fired || crossed;
    log(
      `${g.symbol} ${g.side} ${p.size}: stop covers ${(p.slCovered * 100).toFixed(1)}%, ` +
        `${g.uncovered.toPrecision(6)} uncovered | SL ${g.trigger} | mark ${mark}` +
        `${fired ? " | STOP FIRED" : crossed ? " | HIT" : ""}`,
    );
    if (!hit) continue;
    if (Date.now() - (lastAct.get(g.symbol) ?? 0) < o.cooldownMs) continue;

    // Close the uncovered amount, capped by what is open now: if the account's
    // own stop already fired, what is left IS the uncovered part. The size is
    // read again right before the close (same call closePosition sizes with):
    // the stop often fires between the cycle's read and this point, and a
    // fraction of the old size would then be too small (seen on AVAX, 12 Nov).
    let liveSize = p.size;
    try {
      const preview: any = await (ctx.exchange.client as any).previewPerpClosePnl({
        pool: market.info.poolAddress,
        marginBank: market.info.marginBank,
        account: owner,
      });
      if (preview?.closedQuantity !== undefined) liveSize = Number(BigInt(preview.closedQuantity)) / 10 ** market.info.baseDecimals;
    } catch {
      // Keep the cycle's size; closePosition re-checks anyway.
    }
    if (liveSize <= 0) {
      known.delete(g.symbol);
      continue;
    }
    const fraction = Math.min(1, g.uncovered / liveSize);
    if (!o.live) {
      lastAct.set(g.symbol, Date.now());
      log(`[dry-run] would close ${(fraction * 100).toFixed(1)}% of ${g.symbol} (${(p.size * fraction).toPrecision(6)})`);
      continue;
    }
    const go = o.beforeSend ? await o.beforeSend(g.symbol, market.info.poolAddress) : "send";
    // The cooldown only follows a send attempt; a skipped close is tried again next cycle.
    if (go === "stop") return "stop";
    if (go === "skip") continue;
    // afterSend runs even when the close throws, so gas spent on a failed send is
    // still charged to this account.
    let sent = false;
    lastAct.set(g.symbol, Date.now());
    try {
      const res = await closePosition(ctx, market, owner, { fraction, label: "gap keeper" });
      sent = res.sent;
      log(`${g.symbol}: gap close sent=${res.sent} filled=${res.filled}`);
    } finally {
      await o.afterSend?.(g.symbol, sent);
    }
    if (sent) known.delete(g.symbol);
    else lastAct.delete(g.symbol);
  }

  if (!known.size) log(`nothing uncovered (${report.positions.length} position(s))`);
  return "ok";
}
