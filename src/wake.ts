// Somnia Reactivity for the hub: instead of waiting out the whole poll interval,
// the hub is woken as soon as the node pushes a log that names a guarded account.
//
// Off-chain subscription (somnia_watch over WebSocket): free, no key, nothing
// signed. It watches every perp pool, margin bank and stop registry. Polling stays
// as the fallback, so a dropped socket only means the hub is back to its 10 s
// cycle until the subscription is re-opened.
//
// Turned on with HUB_REACTIVITY=1.

import { createPublicClient, webSocket } from "viem";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

export const REACTIVITY_WS = process.env.REACTIVITY_WS ?? "wss://api.hideki2.infra.testnet.somnia.network/ws";

export interface Wake {
  /** Resolves on the next log that names one of the accounts `owners()` returns. */
  next(): Promise<{ owner: string; at: number }>;
  close(): void;
}

export function startWake(sources: string[], owners: () => string[], log: (line: string) => void): Wake {
  let waiter: ((v: { owner: string; at: number }) => void) | null = null;
  // An event that lands while the hub is busy with a cycle is kept, so the next
  // wait returns at once instead of sleeping the whole poll interval.
  let pending: { owner: string; at: number } | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const open = async (): Promise<void> => {
    if (closed) return;
    try {
      const client = createPublicClient({ chain: hidekiTestnet as any, transport: webSocket(REACTIVITY_WS) });
      const sub: any = await (client.transport as any).subscribe({
        params: ["somnia_watch", { address: sources, eth_calls: [] }],
        onData: (d: any) => {
          const logEntry = d?.result ?? d;
          if (!logEntry) return;
          const hay = [String(logEntry.address ?? ""), ...(logEntry.topics ?? []).map(String), String(logEntry.data ?? "")]
            .join(" ")
            .toLowerCase();
          const owner = owners().find((o) => hay.includes(o.toLowerCase().slice(2)));
          if (!owner) return;
          const hit = { owner, at: Date.now() };
          if (!waiter) {
            pending ??= hit;
            return;
          }
          const w = waiter;
          waiter = null;
          w(hit);
        },
        onError: (e: any) => {
          log(`reactivity: socket error (${String(e?.message ?? e).slice(0, 100)}), back to polling, reopening in 5 s`);
          unsubscribe?.();
          unsubscribe = null;
          setTimeout(() => void open(), 5_000);
        },
      });
      unsubscribe = () => void sub?.unsubscribe?.().catch?.(() => {});
      log(`reactivity: subscribed to ${sources.length} perp contracts at ${REACTIVITY_WS}`);
    } catch (e: any) {
      log(`reactivity: could not subscribe (${String(e?.message ?? e).slice(0, 100)}), polling only, retry in 30 s`);
      setTimeout(() => void open(), 30_000);
    }
  };
  void open();

  return {
    next: () =>
      new Promise((resolve) => {
        if (pending) {
          const p = pending;
          pending = null;
          resolve(p);
        } else waiter = resolve;
      }),
    close: () => {
      closed = true;
      unsubscribe?.();
    },
  };
}
