// npm run check -- <address>          check one account
// npm run check -- --scan [limit]     check every account that has a pending stop

import { checkAccount, createClient, type Report } from "./check.js";

function print(r: Report): void {
  console.log(`\n${r.account}  (${r.checkedAt})`);
  for (const p of r.positions) {
    const legs = p.legs.map((l) => `${l.kind} ${l.triggerPrice} x ${l.wholePosition ? "whole" : l.quantity}`).join(", ");
    console.log(`  ${p.symbol} ${p.side} ${p.size} @ ${p.entry} | TP ${Math.round(p.tpCovered * 100)}% SL ${Math.round(p.slCovered * 100)}% | ${legs || "no stops"}`);
  }
  for (const i of r.idle) console.log(`  ${i.symbol} ${i.state}: ${i.legs.length} stop(s), ${i.restingOrders} resting order(s)`);
  console.log(`  STT held by stops ${r.sttHeld.toFixed(2)}, claimable ${r.sttClaimable.toFixed(2)}`);
  for (const p of r.problems) console.log(`  ! ${p}`);
  if (!r.problems.length) console.log("  ok: nothing to fix");
}

const args = process.argv.slice(2);
const client = createClient();

if (args[0] === "--scan") {
  const limit = Number(args[1] ?? 50);
  const c = client.client as any;
  const pending: any[] = await c.listPerpStopOrders({ limit: 1000 });
  const owners = [...new Set(pending.map((s: any) => String(s.owner).toLowerCase()))].slice(0, limit);
  const markets = new Set(pending.map((s: any) => s.market?.baseSymbol));
  console.log(`markets with pending stops: ${[...markets].join(", ")}`);
  console.log(`${pending.length} pending stops, ${owners.length} owners checked`);
  const tally = { owners: owners.length, withPosition: 0, underCoveredSL: 0, noSL: 0, idle: 0, claimable: 0 };
  for (const o of owners) {
    try {
      const r = await checkAccount(o, client);
      print(r);
      if (r.positions.length) tally.withPosition++;
      if (r.positions.some((p) => p.legs.some((l) => l.kind === "SL") && p.slCovered < 1)) tally.underCoveredSL++;
      if (r.positions.some((p) => !p.legs.some((l) => l.kind === "SL"))) tally.noSL++;
      if (r.idle.length) tally.idle++;
      if (r.sttClaimable > 0) tally.claimable++;
    } catch (e: any) {
      console.log(`\n${o}  read failed: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  console.log("\nSUMMARY", JSON.stringify(tally));
} else {
  print(await checkAccount(args[0] ?? "0x84326A92162Ece92ed257A31073fDd3a6599BF21", client));
}
process.exit(0);
