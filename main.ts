import { runBars } from './vendor/makefun-bars.ts';

// Constants for the trading bot strategy
const EMA_FAST_SPAN = 20;
const EMA_SLOW_SPAN = 120;
const MOM_BARS = 45;
const ENTRY_MOM = 0.0018;
const SIZE_PCT = 90n;
const MAX_ENTRIES = 2;
const COOLDOWN_BARS = 120;
const TRAIL_PCT = 0.0300;
const MAX_HOLD_BARS = 1200;
const SLIPPAGE_BPS = 250;
const MIN_NOTIONAL_FALLBACK = 10000000n;

// Module-level mutable state updated per bar batch
let closes = [];
let emaFast = null;
let emaSlow = null;
let entriesUsed = 0;
let cooldown = 0;
let entryClose = null;
let peakClose = null;
let barsHeld = 0;
let wasHeld = false;

await runBars({
  onBatch(state, batch) {
    // After the hello handshake, the harness sends one batch per bar and the bot answers each batch with orders.
    const closeB = state.close("CBBTC");
    if (closeB === null) {
      return [];
    }
    const close = Number(closeB);

    // 1. Cooldown management
    if (cooldown > 0) {
      cooldown -= 1;
    }

    // 2. Update closes and incremental EMAs
    closes.push(close);

    const fastK = 2 / (EMA_FAST_SPAN + 1);
    if (emaFast === null) {
      emaFast = close;
    } else {
      emaFast = close * fastK + emaFast * (1 - fastK);
    }

    const slowK = 2 / (EMA_SLOW_SPAN + 1);
    if (emaSlow === null) {
      emaSlow = close;
    } else {
      emaSlow = close * slowK + emaSlow * (1 - slowK);
    }

    // 3. Calculate momentum for the current bar
    let momentum = null;
    if (closes.length > MOM_BARS) {
      momentum = closes[closes.length - 1] / closes[closes.length - 1 - MOM_BARS] - 1;
    }

    // 4. Position tracking per bar
    const held = state.positions.get("CBBTC");
    if (held !== undefined) {
      if (!wasHeld) {
        entryClose = close;
        peakClose = close;
        barsHeld = 0;
      } else {
        barsHeld += 1;
        peakClose = Math.max(peakClose ?? close, close);
      }
      wasHeld = true;
    } else {
      entryClose = null;
      peakClose = null;
      barsHeld = 0;
      wasHeld = false;
    }

    // 5. Warm-up check
    if (state.warmingUp) {
      return [];
    }

    // 6. Check exit conditions if holding position
    if (held !== undefined) {
      // Exits are deliberately rare — on 1-minute bars, fees, slippage and pool impact punish churn, so the bot holds a confirmed trend and leaves only on a deep reversal from the peak or at the hold cap.
      const exitTrail = peakClose !== null && close <= peakClose * (1 - TRAIL_PCT);
      const exitHold = barsHeld >= MAX_HOLD_BARS;

      if (exitTrail || exitHold) {
        cooldown = COOLDOWN_BARS;
        return [{ side: "sell", symbol: "CBBTC", qty: held.qty, max_slippage_bps: SLIPPAGE_BPS }];
      }
    } 
    // 7. Check entry conditions if flat
    else if (cooldown === 0 && entriesUsed < MAX_ENTRIES && closes.length >= 130 && momentum !== null && emaFast !== null && emaSlow !== null && emaFast > emaSlow && momentum > ENTRY_MOM && close > emaFast) {
      let notional = (state.equity * SIZE_PCT) / 100n;
      if (notional > state.cash) {
        notional = state.cash;
      }
      const room = state.weightRoom("CBBTC");
      if (room > 0n && notional > room) {
        notional = room;
      }
      let minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (minNotional < MIN_NOTIONAL_FALLBACK) {
        minNotional = MIN_NOTIONAL_FALLBACK;
      }
      if (notional >= minNotional) {
        entriesUsed += 1;
        return [{ side: "buy", symbol: "CBBTC", notional_quote_units: notional, max_slippage_bps: SLIPPAGE_BPS }];
      }
    }

    // 8. Default return no orders
    return [];
  }
});
