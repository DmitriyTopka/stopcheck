// Recreate the "Entire" trap on a test account we own, for the on-chain keeper run:
//   1. long SIZE on LINK-PERP,
//   2. a linked TP/SL pair that stores that fixed size (what the app's "Entire" does),
//   3. add SIZE more, so the stop loss now covers half.
// When the stop fires, StopCheckReactor (subscribed through Somnia Reactivity) closes the rest.
//
//   NETWORK=hideki DRY_RUN=false PRIVATE_KEY=0x... npx tsx onchain/scripts/trap.mts [step]
// step: all (default) | deposit | open | bracket | add | status

import {
  createExchange,
  requireMarket,
  placePerp,
  liveMark,
  alignPrice,
  ORDER_TYPE,
} from "@dreamdex-bot-kit/perp-core";
import { privateKeyToAccount } from "viem/accounts";

const SYMBOL = "LINK-PERP";
const SIZE = 10n ** 18n; // 1.0 LINK, the market minimum is 0.9
const MARGIN = 60n * 10n ** 18n; // USDso
const SL_BELOW_BPS = BigInt(process.env.SL_BELOW_BPS ?? "30");
const step = process.argv[2] ?? "all";

const ctx = createExchange({ withSigner: true });
const ex: any = ctx.exchange;
const market = await requireMarket(ctx.exchange, SYMBOL);
const owner = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`).address;
const bank = market.info.marginBank as `0x${string}`;
const pool = market.info.poolAddress as `0x${string}`;
const mark = (await liveMark(ctx.exchange, market)) ?? 0;
const markRaw = BigInt(Math.round(mark * 1e6)) * 10n ** 12n;
console.log(`owner ${owner} | ${SYMBOL} mark ${mark}`);

async function position(): Promise<bigint> {
  const p: any = await ex.client.getViemClient().readContract({
    address: bank,
    abi: [{ type: "function", name: "getPosition", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "int128" }, { type: "uint128" }, { type: "int256" }, { type: "uint64" }] }],
    functionName: "getPosition",
    args: [owner, pool],
  });
  return BigInt(p[0]);
}

if (step === "all" || step === "deposit") {
  const r = await ex.trader.depositMargin({ marginBank: bank, amount: MARGIN });
  console.log(`deposit ${Number(MARGIN) / 1e18} USDso: ${r.hash}`);
}
if (step === "all" || step === "open") {
  const r = await placePerp({ ctx, market, side: "long", price: markRaw, quantity: SIZE, orderType: ORDER_TYPE.MARKET, slippageBps: 50, label: "open" });
  console.log(`open: sent=${r.sent} filled=${r.filled}`, (r as any).hash ?? "");
}
if (step === "all" || step === "bracket") {
  const tp = alignPrice((markRaw * 11000n) / 10000n, market.info);
  const sl = alignPrice((markRaw * (10000n - SL_BELOW_BPS)) / 10000n, market.info);
  // Fixed quantity on both legs: what the app stores for "Entire" (report #019).
  const res = await ex.trader.placePerpStopOrder({
    registry: market.info.stopRegistry,
    pool,
    operatorRegistry: ctx.config.operatorRegistry,
    isBid: false,
    quantity: SIZE,
    triggerPrice: tp,
    triggerOperator: 0,
    stopOrderType: 1,
    intent: "reduceOnly",
    pair: { isBid: false, quantity: SIZE, triggerPrice: sl, triggerOperator: 1, stopOrderType: 1 },
  });
  console.log(`bracket TP ${Number(tp) / 1e18} (#${res.stopOrderId}) SL ${Number(sl) / 1e18} (#${res.pairedStopOrderId}): ${res.hash ?? ""}`);
}
if (step === "all" || step === "add") {
  const r = await placePerp({ ctx, market, side: "long", price: markRaw, quantity: SIZE, orderType: ORDER_TYPE.MARKET, slippageBps: 50, label: "add" });
  console.log(`add: sent=${r.sent} filled=${r.filled}`, (r as any).hash ?? "");
}
console.log(`position now ${Number(await position()) / 1e18} LINK`);
process.exit(0);
