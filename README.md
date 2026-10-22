# StopCheck for dreamDEX perps

Your take profit and stop loss on dreamDEX may not cover the position you think they cover. StopCheck tells you, for any account, how much of each position is really protected, and a small bot closes the unprotected part when your stop price is hit.

**Try it:** https://dmitriytopka.github.io/stopcheck/ (paste an address, or open `https://dmitriytopka.github.io/stopcheck/#0xYourAddress`). Nothing is signed; the page only reads Somnia Tokyo testnet.

## Why

While testing dreamDEX perps on Somnia Tokyo testnet (Hideki) for the Perps Builder Bounty, we hit three ways a trader ends up less protected than the app suggests:

1. **"Entire" is not the whole position.** A TP/SL set in Entire mode stores the size the position had at that moment. Add to the position and the app still says Entire, but the stop loss closes only the original part. ([report 019](https://github.com/DmitriyTopka/dreamdex-perps-feedback/blob/main/feedback/019-entire-tpsl-covers-only-the-size-at-creation.md))
2. **Cancelled order, live stops.** TP/SL attached to a limit order stay armed after the order is cancelled. They hold 0.15 STT each and later act on whatever position you open next. ([report 022](https://github.com/DmitriyTopka/dreamdex-perps-feedback/blob/main/feedback/022-cancelling-a-limit-order-leaves-its-tpsl-armed.md))
3. **Fees parked, not refunded.** When one leg of a linked TP/SL fills, the other leg's 0.15 STT is credited to a claimable balance instead of coming back. ([report 020](https://github.com/DmitriyTopka/dreamdex-perps-feedback/blob/main/feedback/020-linked-leg-fee-is-credited-not-refunded-sdk-and-kit-say-refunded.md))

These are not only our test accounts. A scan of accounts with pending stops on 2026-10-22 showed live positions with a stop loss covering 84% of a 0.78 BTC short and a take profit covering 48% of a 2,119 ZRO long.

## What it does

- **Check (web page and CLI).** For an address: each open position with the share covered by its stop loss and take profit; stops with no position, split into "waiting for a resting order" and true orphans; STT held by stops and STT waiting to be claimed.
- **Gap keeper (bot, in progress).** A trading key linked to your account with "Link a bot" cannot arm stops for you; only the account can. So the keeper watches instead: when the mark reaches your stop loss and that stop covers only part of the position, it closes the uncovered rest with a reduce order through `placeOrderFor`.

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

## How it reads

Market list, pending stops and candidate positions come from the dreamDEX indexer. Position sizes (`getPerpPosition`), stop sizes and links (`getPerpStopOrders`), resting orders (`getOpenOrdersOnchain`) and claimable fees (`getUnclaimedPerpStopSomi`) are read from the chain, so a lagging indexer cannot make a position look covered. Code: [`src/check.ts`](src/check.ts).

## X posts

To be added.

## License

MIT
