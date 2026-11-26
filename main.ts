// Bounce Dip Bot — a tiny long-only paper-trading bot for hourly Solana bars.
//
// Idea (mine, from first principles): crypto hourly prices spend most of
// their time wiggling around a slow 24-hour mean, with occasional sharp legs
// down. Buying the leg itself loses money; buying *after* the leg has turned
// — the close back above the previous close, while price is still far below
// its 24h mean — catches the snap-back toward the mean. Three guardrails
// keep the idea honest:
//   1. A stop-loss a fixed number of volatility units below the entry, so a
//      dip that keeps falling costs little.
//   2. A take-profit a fixed number of volatility units above the entry, so
//      wins are bigger than the losses the stop allows (about 5:3).
//   3. A 12-bar cooldown after a stop-loss on a symbol, so the bot cannot
//      keep re-buying the same falling knife hour after hour.
// Sizing is a flat slice of equity per trade, capped by the harness weight
// limit, and SOL and JITOSOL are treated as one exposure (staked SOL tracks
// SOL almost one-for-one, so holding both would double one bet).
//
// Everything is deterministic: plain float arithmetic over the closes the
// harness has already sent, no clock, no environment, no randomness.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- tunable constants (chosen on the dev window, kept in the flat region) ---
const MEAN_BARS = 24; // slow mean window, in bars
const MIN_HISTORY = 24; // bars of history needed before any signal
const ENTRY_Z = 2.0; // how far below the mean, in volatility units, a dip must be
const STOP_VOL = 1.5; // stop-loss distance below entry, in volatility units
const TARGET_VOL = 2.5; // take-profit distance above entry, in volatility units
const MAX_HOLD_BARS = 24; // time stop: exit a stale position
const COOLDOWN_BARS = 12; // bars to wait after a stop-loss before re-entering
const STAKE_BPS = 1500; // 15% of equity per new position: drawdown on the dev
// window stays near 2%, far under the 25% guardrail, so the extra size is
// spent on the same high-conviction dip setups instead of new ones.
const MAX_POSITIONS = 6; // at most this many open at once
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// SOL and JITOSOL move together; they share one exposure slot.
function exposureGroup(symbol: string): string {
  return symbol === 'JITOSOL' ? 'SOL' : symbol;
}

interface Held {
  entry: number; // close the entry was decided on (proxy for the fill open)
  bar: number; // seq of the bar the entry was decided on
  stop: number; // exit at or below this close
  target: number; // exit at or above this close
}

const closes = new Map<string, number[]>();
const held = new Map<string, Held>();
const coolingUntil = new Map<string, number>();

function mean(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

// Root-mean-square of the last n hourly log returns ending at index i.
function rmsVol(history: number[], n: number): number {
  const start = Math.max(1, history.length - n);
  let sumSq = 0;
  let count = 0;
  for (let j = start; j < history.length; j++) {
    const r = Math.log(history[j] / history[j - 1]);
    sumSq += r * r;
    count++;
  }
  return count === 0 ? 0 : Math.sqrt(sumSq / count);
}

function pushBar(bar: Bar): void {
  let history = closes.get(bar.symbol);
  if (history === undefined) {
    history = [];
    closes.set(bar.symbol, history);
  }
  history.push(Number(bar.c));
  if (history.length > 64) history.splice(0, history.length - 64);
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) pushBar(bar);
    if (state.warmingUp) return [];

    // Reconcile with the harness: drop tracking for positions that are gone
    // (a sell filled, or a buy that was rejected).
    for (const symbol of [...held.keys()]) {
      if (!state.positions.has(symbol)) held.delete(symbol);
    }

    const fresh = new Set(batch.bars.map((b) => b.symbol));
    const sells: SellInput[] = [];
    const seenGroups = new Set<string>();

    // --- exits: stop, target, or time stop, decided on this bar's close ---
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const position = state.positions.get(symbol);
      const track = held.get(symbol);
      if (position === undefined || track === undefined) continue;
      seenGroups.add(exposureGroup(symbol));
      const close = Number(state.latest.get(symbol)!.c);
      const stopped = close <= track.stop;
      const hitTarget = close >= track.target;
      const stale = state.seq - track.bar >= MAX_HOLD_BARS;
      if (stopped || hitTarget || stale) {
        if (stopped) coolingUntil.set(symbol, state.seq + COOLDOWN_BARS);
        sells.push({ side: 'sell', symbol, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        held.delete(symbol);
      }
    }

    // --- entries: deep dip below the 24h mean, already turning back up ---
    interface Candidate { symbol: string; z: number; vol: number; close: number }
    const candidates: Candidate[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      if (state.positions.has(symbol)) continue;
      if (held.has(symbol)) continue;
      if (seenGroups.has(exposureGroup(symbol))) continue;
      const until = coolingUntil.get(symbol);
      if (until !== undefined && state.seq < until) continue;
      const history = closes.get(symbol);
      if (history === undefined || history.length < MIN_HISTORY) continue;
      const close = history[history.length - 1];
      const prev = history[history.length - 2];
      const open = Number(state.latest.get(symbol)!.o);
      const window = history.slice(history.length - MEAN_BARS);
      const slowMean = mean(window);
      const vol = rmsVol(history, MEAN_BARS);
      if (vol <= 0 || slowMean <= 0) continue;
      const z = (slowMean - close) / (slowMean * vol);
      // Deep below the mean, and this bar already turned up: close above
      // the previous close and above its own open.
      if (z >= ENTRY_Z && close > prev && close > open) {
        candidates.push({ symbol, z, vol, close });
      }
    }
    // Deepest dips first; ties break by universe order (deterministic).
    candidates.sort((a, b) => b.z - a.z);

    const orders: (SellInput | BuyInput)[] = sells.slice(0, state.hello.caps.max_orders_per_bar);
    const openSlots = MAX_POSITIONS - state.positions.size + sells.length;
    const stakeCap = (BigInt(STAKE_BPS) * state.equity) / BPS;
    let cash = state.cash;
    let slots = openSlots;
    for (const c of candidates) {
      if (slots <= 0 || orders.length >= state.hello.caps.max_orders_per_bar) break;
      const room = state.weightRoom(c.symbol);
      let slice = stakeCap < room ? stakeCap : room;
      if (cash < slice) slice = cash;
      if (slice <= 0n || slice < BigInt(state.hello.fees.min_notional_quote_units)) continue;
      orders.push({ side: 'buy', symbol: c.symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      held.set(c.symbol, {
        entry: c.close,
        bar: state.seq,
        stop: c.close * (1 - STOP_VOL * c.vol),
        target: c.close * (1 + TARGET_VOL * c.vol),
      });
      seenGroups.add(exposureGroup(c.symbol));
      cash -= slice;
      slots--;
    }
    return orders;
  },
});
