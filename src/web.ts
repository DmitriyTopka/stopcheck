import { checkAccount, createClient, listAllPerpMarkets, type PositionCheck, type Report, type StopLeg } from "./check.js";
import type { ScanSummary } from "./cli.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
// Never round a partial cover up to 100% or a small one down to 0%: 99.6% printed
// as "100%" next to "the rest has no stop" reads as a contradiction.
const pct = (x: number) => {
  const v = x * 100;
  if (v >= 100) return "100%";
  if (v > 0 && v < 1) return `${v.toFixed(1)}%`;
  return `${Math.floor(v)}%`;
};
const client = createClient();

// ---- Network today: totals from the daily scan (docs/scan-latest.json) ----

const day = (iso: string) => iso.slice(0, 10);
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

/** "up 2 since 4 Nov", "same as 4 Nov"; empty when there is no earlier day to compare with. */
function trend(now: number, before: number | undefined, since: string, fmt: (x: number) => string = String): string {
  if (before === undefined || !Number.isFinite(before)) return "";
  const d = now - before;
  if (Math.abs(d) < 1e-9) return `same as ${since}`;
  return `${d > 0 ? "up" : "down"} ${fmt(Math.abs(d))} since ${since}`;
}

function networkBlock(s: ScanSummary, history: ScanSummary[]): string {
  // Compare with the latest scan from an earlier day, so two runs on one day do not hide the change.
  const prev = [...history].reverse().find((h) => day(h.time) < day(s.time));
  const since = prev ? dateLabel(prev.time) : "";
  const share = (x: ScanSummary) => (x.stopsCreated7d ? Math.round((x.fixedSizeStops7d / x.stopsCreated7d) * 100) : 0);
  const cell = (value: string, tone: string, label: string, t: string) =>
    `<div><b class="${tone}">${value}</b><span>${label}</span>${t ? `<em>${esc(t)}</em>` : ""}</div>`;
  const uncovered = s.uncoveredNotionalUsd ? ` (${usd(s.uncoveredNotionalUsd)} left open)` : "";
  return `<h2>Network today <span>${s.accountsScanned} accounts with pending stops, read ${esc(dateLabel(s.time))}</span></h2>
    <div class="nums">
      ${cell(String(s.partlyCovered), s.partlyCovered ? "bad" : "", `accounts whose stop loss covers only part of a position${uncovered}`, trend(s.partlyCovered, prev?.partlyCovered, since))}
      ${cell(String(s.orphanStops), s.orphanStops ? "part" : "", `stops with no position or order behind them, in ${s.orphanAccounts} accounts`, trend(s.orphanStops, prev?.orphanStops, since))}
      ${cell(s.sttToClaim.toFixed(2), "", `STT waiting to be claimed in ${s.accountsWithSttToClaim} accounts`, trend(s.sttToClaim, prev?.sttToClaim, since, (x) => x.toFixed(2)))}
      ${cell(`${share(s)}%`, share(s) ? "part" : "", `of ${s.stopsCreated7d} stops set in the last 7 days store a fixed size, the "Entire" trap`, trend(share(s), prev && prev.stopsCreated7d ? share(prev) : undefined, since, (x) => `${x} pts`))}
    </div>
    <p>Is your account one of them? Paste your address below. The scan runs every day, so check again after you add to a position or move a stop.</p>
    <p class="muted">Updated ${esc(s.time.replace("T", " ").replace("Z", " UTC"))}, block ${s.block ?? "?"}. ${history.length > 1 ? `${history.length} scans so far.` : "First daily scan."}</p>`;
}

// ---- Keeper status: guarded accounts and closes (docs/keeper-status.json, src/status.ts) ----

interface KeeperStatus {
  time: string;
  bot: string;
  guardedAccounts: number;
  closes: { time: string; market: string; tx: string }[];
}

const EXPLORER_TX = "https://explorer.testnet.somnia.network/tokyo/tx/";

function keeperBlock(k: KeeperStatus): string {
  const n = k.guardedAccounts;
  const list = k.closes
    .map((c) => `<a href="${EXPLORER_TX}${esc(c.tx)}">${esc(dateLabel(c.time))}, ${esc(c.market)}</a>`)
    .join(" · ");
  return `<p><b>Gap keeper:</b> guards ${n} account${n === 1 ? "" : "s"} linked to its key today. ${k.closes.length} close${k.closes.length === 1 ? "" : "s"} on chain so far${list ? `: ${list}` : ""}. Link the key <code>${esc(k.bot.slice(0, 6))}…${esc(k.bot.slice(-4))}</code> with Link a bot to be guarded too (<a href="https://github.com/DmitriyTopka/stopcheck#protect-your-own-account">how</a>).</p>`;
}

async function loadNetwork(): Promise<void> {
  try {
    const [latest, history, keeper] = await Promise.all([
      fetch("scan-latest.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)),
      fetch("scan-history.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch("keeper-status.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!latest || typeof latest.partlyCovered !== "number") return;
    const el = $<HTMLElement>("net");
    el.innerHTML =
      networkBlock(latest, Array.isArray(history) ? history : []) +
      (keeper && typeof keeper.guardedAccounts === "number" && Array.isArray(keeper.closes) ? keeperBlock(keeper) : "");
    el.hidden = false;
  } catch {
    // No scan yet or offline: the address check works without it.
  }
}

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

const PAGE = "https://dmitriytopka.github.io/stopcheck/";
/** The bot key the hosted keeper (src/hub.ts) sends with. */
const BOT = "0x13f05c8e15cC0d7d3abff02C144fb74778018a55";

/**
 * The one number worth sharing: how much of the account's open exposure, by
 * entry notional, a stop loss would actually close. A stop that covers half of
 * the biggest position matters more than a full stop on a tiny one.
 */
function slShare(r: Report): number | undefined {
  let total = 0;
  let covered = 0;
  for (const p of r.positions) {
    const notional = p.size * p.entry;
    total += notional;
    covered += notional * p.slCovered;
  }
  return total > 0 ? covered / total : undefined;
}

function shareCard(r: Report): string {
  const share = slShare(r);
  const orphans = r.idle.filter((i) => i.state === "orphan").reduce((a, i) => a + i.legs.length, 0);
  let big: string;
  let line: string;
  let tone: string;
  if (share === undefined) {
    big = orphans ? `${orphans}` : "0";
    line = orphans ? `stop${orphans > 1 ? "s" : ""} armed with no position behind ${orphans > 1 ? "them" : "it"}` : "open positions, nothing to check";
    tone = orphans ? "part" : "full";
  } else {
    big = pct(share);
    line = "of my open position value is covered by a stop loss";
    tone = share >= 1 ? "full" : share > 0 ? "part" : "none";
  }
  // The shared post links to the page, not to this address: a trader decides
  // for themselves whether to publish their wallet.
  const text =
    share === undefined
      ? `StopCheck: does your dreamDEX stop loss cover your whole position? Check any address, read-only. @DreamDEXSomnia`
      : `My stop losses on @DreamDEXSomnia cover ${pct(share)} of my open positions. Check yours, read-only:`;
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(PAGE)}`;
  return `<section class="share ${tone}">
      <div class="big">${big}</div>
      <div class="line">${line}</div>
      <div class="extra">${orphans && share !== undefined ? `${orphans} stop${orphans > 1 ? "s" : ""} armed with no position · ` : ""}${r.sttClaimable > 0 ? `${r.sttClaimable.toFixed(2)} STT to claim · ` : ""}StopCheck for dreamDEX</div>
      <div class="actions"><button type="button" id="copy">Copy link</button><a href="${intent}" target="_blank" rel="noopener">Share on X</a></div>
    </section>`;
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
  return `${shareCard(r)}
    ${headline}
    <p class="muted small">Want this account guarded? Link <code title="${BOT}">0x13f0...8a55</code> as a bot (Perps) and the hosted keeper picks it up within a minute.</p>
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
  stopLive();
  try {
    await show(address);
    void watchLive(address);
  } catch (e: any) {
    out.innerHTML = `<p class="verdict warn">Could not read this account: ${esc(String(e?.message ?? e).slice(0, 200))}</p>`;
  }
}

/** Reads the account and draws the card; also used for live refreshes. */
async function show(address: string): Promise<void> {
  const out = $<HTMLDivElement>("out");
  out.innerHTML = render(await checkAccount(address, client));
    $<HTMLButtonElement>("copy")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      try {
        await navigator.clipboard.writeText(`${PAGE}#${address}`);
        btn.textContent = "Link copied";
      } catch {
        btn.textContent = "Copy failed";
      }
    });
}

// ---- Live card: Somnia Reactivity (off-chain subscription over WebSocket) ----
// The node pushes every log from the perp pools, margin banks and stop registries
// as it lands in a block (somnia_watch). When a log names this account, the card
// is read again from the chain. Free, no key, nothing signed. If the socket drops,
// the card simply stops updating and says so.

const REACTIVITY_WS = "wss://api.hideki2.infra.testnet.somnia.network/ws";
let live: WebSocket | null = null;

function liveNote(html: string, on: boolean): void {
  const el = $<HTMLParagraphElement>("live");
  el.innerHTML = html;
  el.className = on ? "live on" : "live";
  el.hidden = false;
}

function stopLive(): void {
  const ws = live;
  live = null;
  ws?.close();
  $<HTMLParagraphElement>("live").hidden = true;
}

async function watchLive(address: string): Promise<void> {
  const rows: any[] = await listAllPerpMarkets(client.client as any);
  const sources = new Set<string>([address.toLowerCase()]);
  for (const r of rows) for (const a of [r.poolAddress, r.marginBank, r.stopRegistry]) if (a) sources.add(String(a).toLowerCase());
  const needle = address.toLowerCase().slice(2);
  const ws = new WebSocket(REACTIVITY_WS);
  live = ws;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let updates = 0;
  let lastRead = Date.now();
  const watching = `<b>Live via Somnia Reactivity.</b> This card updates by itself when this account's positions or stops change on chain`;
  ws.onopen = () =>
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["somnia_watch", { address: [...sources], eth_calls: [] }] }));
  ws.onmessage = (m) => {
    if (live !== ws) return;
    let j: any;
    try {
      j = JSON.parse(String(m.data));
    } catch {
      return;
    }
    if (j.id === 1) {
      if (j.error) liveNote("Live updates are not available right now. The card above is still correct as of the time shown.", false);
      else liveNote(`${watching}.`, true);
      return;
    }
    const log = j.params?.result;
    if (!log) return;
    const hit =
      String(log.address ?? "").toLowerCase() === address.toLowerCase() ||
      (log.topics ?? []).some((t: string) => String(t).toLowerCase().includes(needle)) ||
      String(log.data ?? "").toLowerCase().includes(needle);
    if (!hit) return;
    // One trade emits several logs: wait for the burst to end, then read once,
    // and never more often than every 5 s for a busy account.
    if (timer) return;
    const wait = Math.max(1500, lastRead + 5000 - Date.now());
    timer = setTimeout(async () => {
      timer = undefined;
      lastRead = Date.now();
      if (live !== ws) return;
      try {
        await show(address);
        updates++;
        const at = new Date().toISOString().slice(11, 19);
        liveNote(`${watching}. Updated at ${at} UTC after an on-chain event (${updates} so far).`, true);
      } catch {
        // Keep the last card; the next event tries again.
      }
    }, wait);
  };
  ws.onclose = () => {
    if (live === ws) liveNote("Live updates stopped (connection closed). Press Check to read the account again.", false);
  };
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
void loadNetwork();
