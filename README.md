# StopCheck for dreamDEX perps

While testing dreamDEX perps we filed 21 feedback reports; this tool fixes the one that can cost a trader the most.

Your take profit and stop loss on dreamDEX may not cover the position you think they cover. StopCheck tells you, for any account, how much of each position a stop loss really protects. A small bot then closes the unprotected part when your stop price is hit.

**Demo video (50 s):** [demo/stopcheck-demo.mp4](demo/stopcheck-demo.mp4)

**Try it:** https://dmitriytopka.github.io/stopcheck/ (paste an address, or open `https://dmitriytopka.github.io/stopcheck/#0xYourAddress`). Nothing is signed; the page only reads Somnia Tokyo testnet.

## Why

While testing dreamDEX perps on Somnia Tokyo testnet (Hideki) for the Perps Builder Bounty, we hit three ways a trader ends up less protected than the app suggests:

1. **"Entire" is not the whole position.** A TP/SL set in Entire mode stores the size the position had at that moment. Add to the position and the app still says Entire, but the stop loss closes only the original part. ([report 019](https://github.com/DmitriyTopka/dreamdex-perps-feedback/blob/main/feedback/019-entire-tpsl-covers-only-the-size-at-creation.md))
2. **Cancelled order, live stops.** TP/SL attached to a limit order stay armed after the order is cancelled. They hold 0.15 STT each and later act on whatever position you open next. ([report 022](https://github.com/DmitriyTopka/dreamdex-perps-feedback/blob/main/feedback/022-cancelling-a-limit-order-leaves-its-tpsl-armed.md))
3. **Fees parked, not refunded.** When one leg of a linked TP/SL fills, the other leg's 0.15 STT is credited to a claimable balance instead of coming back. ([report 020](https://github.com/DmitriyTopka/dreamdex-perps-feedback/blob/main/feedback/020-linked-leg-fee-is-credited-not-refunded-sdk-and-kit-say-refunded.md))

These are not only our test accounts. A scan of accounts with pending stops on 2026-10-22 showed live positions with a stop loss covering 84% of a 0.78 BTC short and a take profit covering 48% of a 2,119 ZRO long.

## What it does

- **Check (web page and CLI). Start here.** Paste an address and get a share card with one number: how much of the account's open position value a stop loss covers. Below it, for each position: each open position with the share covered by its stop loss and take profit; stops with no position, split into "waiting for a resting order" and true orphans; STT held by stops and STT waiting to be claimed.
- **Gap keeper (bot).** A trading key linked to your account with "Link a bot" cannot arm stops for you; only the account can. So the keeper watches instead: when the mark reaches your stop loss and that stop covers only part of the position, it closes the uncovered rest with a reduce order through `placeOrderFor`.

## Live demo (Somnia Tokyo testnet, 2026-10-22)

The trap from report 019, reproduced in the dreamDEX app and closed by the keeper. Account `0x84326A92162Ece92ed257A31073fDd3a6599BF21`, BTC-PERP, linked bot key `0x13f05c8e15cC0d7d3abff02C144fb74778018a55`.

| time (UTC) | what happened | transaction |
|---|---|---|
| 19:18:57 | Long 0.00018 BTC in the app | [0xfb3f20ae…955ac3](https://explorer.testnet.somnia.network/tokyo/tx/0xfb3f20ae55c32a67a7402112893a4f82ee9f4bb61e61ac2883097ef618955ac3) |
| 19:19 | TP/SL set in **Entire** mode (TP 90,000, SL 81,260): both legs store 0.00018 BTC | |
| 19:21:21 | Added 0.00018 BTC, position now 0.00036. App still says Entire; StopCheck: "stop loss covers 50%" | [0xda18d4a5…62e8d9](https://explorer.testnet.somnia.network/tokyo/tx/0xda18d4a5b124ad3858ddf5ec39a81064b1fa327532045eb5b31b0001d562e8d9) |
| 19:31:45 | Stop loss moved to 81,385 in the app. The new leg is again 0.00018 BTC, so editing does not fix it | |
| 19:34:35 | Mark crosses 81,385, the stop registry fires the account's own stop loss: closes 0.00018 | [0x2db1fbb6…825178](https://explorer.testnet.somnia.network/tokyo/tx/0x2db1fbb610bcc905796b47326246ea95e5b055c011ca4b907fb9b3f043825178) |
| **19:34:38** | **Gap keeper closes the other 0.00018 with `placeOrderFor` from the linked bot key** | [0x8524c1fb…67abc2](https://explorer.testnet.somnia.network/tokyo/tx/0x8524c1fb944ecc7ceacfcd08087aa940e0acfc5d77f75a1dad7cbff8dc67abc2) |

Without the keeper, half of the position would have stayed open with no stop after the trader's stop loss "fired on the entire position". Keeper log: [`demo/keeper-2026-10-22.log`](demo/keeper-2026-10-22.log). Gas spent by the bot for the whole run: 0.0098 STT.

## Next

A linked bot is authorised per owner and operator (`isOperatorAuthorized(owner, operator, selector)`), and `placeOrderFor` takes the owner as an argument. So one hosted keeper could serve every trader who links its address, with no server on their side. We have not built that yet; on testnet we did not want to run orders for strangers.

## Who it is for

Anyone trading perps on dreamDEX who sets TP/SL and then adds to or trims a position, and bot builders who arm brackets through the Markets SDK.

## Run it

```bash
npm install
npm run check -- 0xYourAddress     # one account
npm run check -- --scan 100        # accounts with pending stops
npm run build:web                  # rebuilds docs/app.js for the page
```

Node 20+. Reads go to the public Hideki RPC and indexer; no keys are needed for the check.

### Gap keeper

The keeper reuses the official [dreamdex-bot-kit](https://github.com/somnia-chain/dreamdex-bot-kit) (`@dreamdex-bot-kit/perp-core`) for the linked trading key and the reduce order. Clone the kit, run `npm install` there, then link its perp-core into this repo:

```bash
mkdir -p node_modules/@dreamdex-bot-kit
ln -s /path/to/dreamdex-bot-kit/packages/perp-core node_modules/@dreamdex-bot-kit/perp-core
PRIVATE_KEY=0x... OWNER_ADDRESS=0xYourAccount NETWORK=hideki npm run keeper              # dry run, logs only
PRIVATE_KEY=0x... OWNER_ADDRESS=0xYourAccount NETWORK=hideki DRY_RUN=false npm run keeper
```

`PRIVATE_KEY` is the bot key you linked in the app with Link a bot (Perps), not your wallet key. Every 10 seconds the keeper re-reads the account. For a position whose stop loss covers only part of it, it remembers the uncovered size and the first stop-loss trigger. When the mark crosses that trigger it re-reads the position and closes the uncovered size, capped at what is still open, so it never closes more than your stop left behind. Code: [`src/keeper.ts`](src/keeper.ts).

## How it reads

Market list, pending stops and candidate positions come from the dreamDEX indexer. Position sizes (`getPerpPosition`), stop sizes and links (`getPerpStopOrders`), resting orders (`getOpenOrdersOnchain`) and claimable fees (`getUnclaimedPerpStopSomi`) are read from the chain, so a lagging indexer cannot make a position look covered. Code: [`src/check.ts`](src/check.ts).

## X posts

1. [The "Entire" trap and the bot that closed the other half (with the demo video)](https://x.com/SirenaMC2/status/2113498955908812882)
2. [463 accounts scanned: 19 with a stop loss covering only part of the position](https://x.com/SirenaMC2/status/2113499393676488753)
3. [Cancelled limit orders leave their TP/SL armed](https://x.com/SirenaMC2/status/2113499520369910070)

All three tag @DreamDEXSomnia and were posted on 2026-10-23.

## License

MIT
