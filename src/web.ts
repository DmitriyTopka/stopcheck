import { checkAccount, createClient, type PositionCheck, type Report, type StopLeg } from "./check.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const client = createClient();

function bar(label: string, share: number, present: boolean): string {
  if (!present) return `<div class="cover"><span>${label}</span><div class="track"><i style="width:0"></i></div><b class="none">none</b></div>`;
  const tone = share >= 1 ? "full" : share > 0 ? "part" : "none";
  return `<div class="cover"><span>${label}</span><div class="track"><i class="${tone}" style="width:${Math.round(share * 100)}%"></i></div><b class="${tone}">${pct(share)}</b></div>`;
}

function legRow(l: StopLeg): string {
  const size = l.wholePosition ? "whole position" : `${l.quantity}`;
  return `<li><em class="${l.kind === "wrong side" ? "bad" : ""}">${l.kind}</em> at ${l.triggerPrice} for ${size}${l.linkedTo ? " · linked" : ""}</li>`;
}

function positionCard(p: PositionCheck): string {
  const hasTP = p.legs.some((l) => l.kind === "TP");
  const hasSL = p.legs.some((l) => l.kind === "SL");
  return `<article class="card">
    <header><h3>${esc(p.symbol)}</h3><span class="pill ${p.side}">${p.side} ${p.size}</span><span class="muted">entry ${p.entry}</span></header>
    ${bar("Stop loss", p.slCovered, hasSL)}
    ${bar("Take profit", p.tpCovered, hasTP)}
    ${p.legs.length ? `<ul class="legs">${p.legs.map(legRow).join("")}</ul>` : ""}
  </article>`;
}

function render(r: Report): string {
  const headline = r.problems.length
    ? `<p class="verdict warn">${r.problems.length} thing${r.problems.length > 1 ? "s" : ""} to fix</p>`
    : `<p class="verdict ok">Nothing to fix. Every stop matches a position.</p>`;
  const problems = r.problems.length ? `<ol class="problems">${r.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>` : "";
  const idle = r.idle
    .map(
      (i) => `<article class="card idle"><header><h3>${esc(i.symbol)}</h3><span class="pill ${i.state}">${i.state === "orphan" ? "no position, no order" : "waiting for an order to fill"}</span></header><ul class="legs">${i.legs.map(legRow).join("")}</ul></article>`,
    )
    .join("");
  return `${headline}
    <div class="stats">
      <div><b>${r.positions.length}</b><span>open positions</span></div>
      <div><b>${r.sttHeld.toFixed(2)}</b><span>STT held by stops</span></div>
      <div><b>${r.sttClaimable.toFixed(2)}</b><span>STT to claim</span></div>
    </div>
    ${problems}
    ${r.positions.map(positionCard).join("")}
    ${idle}
    <p class="muted small">Read from Somnia Tokyo testnet (Hideki) at ${esc(r.checkedAt)}. Nothing is signed or sent.</p>`;
}

async function run(address: string): Promise<void> {
  const out = $<HTMLDivElement>("out");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    out.innerHTML = `<p class="verdict warn">That is not a wallet address. It should start with 0x and have 40 more characters.</p>`;
    return;
  }
  out.innerHTML = `<p class="muted">Reading positions and stops…</p>`;
  history.replaceState(null, "", `#${address}`);
  try {
    out.innerHTML = render(await checkAccount(address, client));
  } catch (e: any) {
    out.innerHTML = `<p class="verdict warn">Could not read this account: ${esc(String(e?.message ?? e).slice(0, 200))}</p>`;
  }
}

$<HTMLFormElement>("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  void run($<HTMLInputElement>("addr").value.trim());
});
// A shared link carries the address after #. Changing only the hash does not
// reload the page, so listen for it as well as reading it on load.
function fromHash(): void {
  const a = location.hash.slice(1);
  if (!a || a === $<HTMLInputElement>("addr").value) return;
  $<HTMLInputElement>("addr").value = a;
  void run(a);
}
window.addEventListener("hashchange", fromHash);
fromHash();
