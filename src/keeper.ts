// Gap keeper: closes the part of a position your stop loss does not cover.
//
// A trading key linked with "Link a bot" cannot arm stops for the account, so
// the keeper cannot fix a short stop by re-arming it. It watches instead. When
// the mark reaches the account's stop-loss trigger and that stop covers only
// part of the position, it closes the uncovered rest with a reduce order sent
// through placeOrderFor (perp-core's closePosition).
//
// Needs a dreamdex-bot-kit checkout next to this repo (see README):
//   PRIVATE_KEY=<linked trading key> OWNER_ADDRESS=<account> NETWORK=hideki \
//   DRY_RUN=false npx tsx src/keeper.ts

import { createExchange, envNum, loadEnv, onStop, shutdown, sleep } from "@dreamdex-bot-kit/perp-core";
import { privateKeyToAccount } from "viem/accounts";
import { gapStep, newOwnerState } from "./gap.js";

loadEnv();
const POLL_MS = envNum("KEEPER_POLL_MS", 10_000);
// After a close, give the chain and the indexer time to show it before acting
// on the same position again.
const COOLDOWN_MS = envNum("KEEPER_COOLDOWN_MS", 30_000);
// Stop for good once the bot key has spent this much STT since start, so a
// close that keeps failing cannot drain the key.
const GAS_CAP_STT = envNum("KEEPER_GAS_CAP_STT", 1);
const RPC = process.env.KEEPER_RPC ?? "https://api.hideki2.infra.testnet.somnia.network";

async function balanceStt(address: string): Promise<number> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  return Number(BigInt((await res.json()).result)) / 1e18;
}

async function main(): Promise<void> {
  const live = process.env.DRY_RUN === "false";
  const ctx = createExchange({ withSigner: true });
  const owner = (ctx.config.owner || ctx.exchange.walletAddress) as `0x${string}`;
  const stopped = onStop();
  const state = newOwnerState();

  const bot = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`).address;
  const startBalance = await balanceStt(bot);

  console.log(`gap keeper for ${owner} | poll ${POLL_MS / 1000}s | dry-run ${!live} | gas cap ${GAS_CAP_STT} STT from ${startBalance.toFixed(4)}`);

  while (!stopped()) {
    // The per-account cycle lives in gap.ts so the hosted hub runs the same code.
    const result = await gapStep({
      ctx,
      owner,
      state,
      live,
      cooldownMs: COOLDOWN_MS,
      beforeSend: async () => {
        const spent = startBalance - (await balanceStt(bot));
        if (spent >= GAS_CAP_STT) {
          console.log(`gas cap reached: spent ${spent.toFixed(4)} STT, stopping`);
          return "stop";
        }
        return "send";
      },
    });
    if (result === "stop") {
      await shutdown(ctx);
      return;
    }
    await sleep(POLL_MS, stopped);
  }
  await shutdown(ctx);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
