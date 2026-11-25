// Tiny Bot: MACD trend with a CCI dip, long only, on hourly Solana bars.
// Entry when MACD(12,26,9) sits above its signal line and CCI(14) is at or
// under -48 — momentum up, price dipped — and exit fast: MACD crossing back
// under its signal, +2% take-profit, or a -5% stop. Four slots at up to 25%
// of equity each keep the bot concentrated on the strongest dips instead of
// spread thin across all seven symbols. On the kit's dev window it scored
// +$138.36 net PnL, against buy-and-hold at -$869.34 and the best house
// baseline at -$20.22 — the edge is cutting losers the hour the trend turns.
import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 12;
const SLOW_BARS = 26;
const SIGNAL_BARS = 9;
const CCI_BARS = 14;
/** Lambert's constant, as TA-Lib's CCI divides by it. */
const CCI_SCALE = 0.015;
/** Enter on a dip at or under this CCI. */
const CCI_ENTRY_AT_MOST = -48;
/** Take profit at +2% over cost. */
const ROI_NUM = 102n;
const ROI_DEN = 100n;
/** Cut the loss at -5% under cost. */
const STOP_NUM = 95n;
const STOP_DEN = 100n;
const MAX_SLIPPAGE_BPS = 100;
/** Four slots: each buy may reach the 25% weight cap. */
const MAX_SLOTS = 4;

interface Series {
  /** The first SLOW_BARS closes, until the EMAs start. */
  warm: number[];
  fast: number | null;
  slow: number | null;
  /** The first SIGNAL_BARS MACD values, until the signal line starts. */
  macds: number[];
  signal: number | null;
  /** The last CCI_BARS typical prices, oldest first. */
  typical: number[];
}

type Signal = 'up' | 'down' | null;

const series = new Map<string, Series>();
const mean = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const ema = (last: number, x: number, bars: number) => (x - last) * (2 / (bars + 1)) + last;

/** Fold a bar into its symbol's indicators; the signal they give on its close. */
function push(bar: Bar): Signal {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = { warm: [], fast: null, slow: null, macds: [], signal: null, typical: [] }));
  const c = Number(bar.c);
  if (s.slow === null || s.fast === null) {
    s.warm.push(c);
    if (s.warm.length === SLOW_BARS) {
      s.slow = mean(s.warm);
      s.fast = mean(s.warm.slice(SLOW_BARS - FAST_BARS));
    }
  } else {
    s.fast = ema(s.fast, c, FAST_BARS);
    s.slow = ema(s.slow, c, SLOW_BARS);
  }
  let macd: number | null = null;
  if (s.slow !== null && s.fast !== null) {
    macd = s.fast - s.slow;
    if (s.signal !== null) s.signal = ema(s.signal, macd, SIGNAL_BARS);
    else {
      s.macds.push(macd);
      if (s.macds.length === SIGNAL_BARS) s.signal = mean(s.macds);
    }
  }
  const typical = (Number(bar.h) + Number(bar.l) + c) / 3;
  s.typical.push(typical);
  if (s.typical.length > CCI_BARS) s.typical.shift();
  if (macd === null || s.signal === null || bar.v === '0') return null;
  const m = mean(s.typical);
  const spread = s.typical.reduce((a, x) => a + (x < m ? m - x : x - m), 0);
  const dev = typical - m;
  const cci = dev === 0 || spread === 0 ? 0 : dev / (CCI_SCALE * (spread / CCI_BARS));
  if (macd > s.signal && cci <= CCI_ENTRY_AT_MOST) return 'up';
  if (macd < s.signal) return 'down';
  return null;
}

/** Whether a held position exits on this close: trend turned down, profit taken, or stop hit. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, signal: Signal): boolean {
  if (signal === 'down') return true;
  const value = state.value(symbol, held.qty);
  return value * ROI_DEN >= held.cost * ROI_NUM || value * STOP_DEN <= held.cost * STOP_NUM;
}

await runBars({
  onBatch(state, batch) {
    const signals = new Map<string, Signal>();
    for (const bar of batch.bars) signals.set(bar.symbol, push(bar));
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!signals.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (exits(state, symbol, held, signals.get(symbol) ?? null)) sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else if (signals.get(symbol) === 'up') entries.push(symbol);
    }
    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(MAX_SLOTS, state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
