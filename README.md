# Bounce Dip Bot — Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/hadiba924-prog/tiny-bot-beat-buy-and-hold/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/hadiba924-prog/tiny-bot-beat-buy-and-hold/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny long-only paper-trading bot for hourly Solana bars. It beats
buy-and-hold by mostly sitting in cash and only buying sharp dips after
they have already turned back up.

## Strategy

- **Signal:** an asset's close at least 2.0 volatility units below its
  24-hour mean, with the bar already turning up (close above the previous
  close and above its own open). The dip alone is not enough — the turn is
  what separates a snap-back from a falling knife.
- **Risk:** stop-loss 1.5 volatility units below entry, take-profit 2.5
  volatility units above entry, 24-bar time stop.
- **Discipline:** 12-bar cooldown after a stop-loss on a symbol, so the bot
  cannot re-buy the same falling asset hour after hour.
- **Sizing:** 15% of equity per position, at most 6 open, at most 25% weight
  per position. SOL and JITOSOL count as one exposure (staked SOL tracks
  SOL almost one-for-one).
- **Deterministic:** plain float arithmetic over the closes the harness
  sent; no clock, no environment, no randomness.

## Dev-window result (grade-local, `--driver process`)

- Net PnL **+215.71 USDC** (+2.16% on $10,000)
- Buy-and-hold −869.34 USDC; best house baseline (macd-cci) −20.22 USDC
- 42 trades, win rate 47.6%, max drawdown 2.28%, Sharpe 0.081
- 0 rejected orders; guardrails met; two runs produce a byte-identical
  action log

## Files

- `main.ts` — the strategy (Node 22 TypeScript, stdlib + vendored SDK only)
- `vendor/makefun-bars.ts` — the kit SDK, copied byte-identical
- `LICENSE` — MIT

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
