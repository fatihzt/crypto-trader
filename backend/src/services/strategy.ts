// ============================================
// STRATEGY SERVICE - Multi-Signal Trading
// ============================================

import { randomUUID } from 'crypto';
import type {
  TradingConfig,
  Candle,
  Indicators,
  RegimeState,
  TradeSignal,
  SignalStrength,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

export class StrategyService {
  private config: TradingConfig;
  private lastSignalTime: Map<string, number> = new Map();

  constructor(config: TradingConfig) {
    this.config = config;
    logger.info('Strategy', 'Multi-signal strategy initialized', {
      cooldownCandles: config.cooldownCandles,
      riskPerTrade: config.riskPerTradePercent,
    });
  }

  /**
   * Evaluate market - uses multiple signal types for more frequent trades
   */
  public evaluate(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    // Regime filter is now softer - only block on DANGER
    if (regime.decision === 'DANGER') {
      return null;
    }

    // Cooldown: only 2 candles (30 min)
    if (!this.canTrade(symbol, candles)) {
      return null;
    }

    const currentPrice = candles[candles.length - 1].close;

    // Try multiple strategies in order of priority
    const signal =
      this.checkEMACrossover(symbol, candles, indicators, regime) ||
      this.checkRSIReversal(symbol, candles, indicators, regime) ||
      this.checkMomentumBreakout(symbol, candles, indicators, regime) ||
      this.checkStructureBreak(symbol, candles, indicators, regime) ||
      this.checkEMABounce(symbol, candles, indicators, regime) ||
      this.checkMeanReversion(symbol, candles, indicators, regime) ||
      this.checkCandleTrend(symbol, candles, indicators, regime) ||
      this.checkQuickScalp(symbol, candles, indicators, regime);

    if (signal) {
      this.updateLastSignalTime(symbol, candles);
      return signal;
    }

    return null;
  }

  /**
   * STRATEGY 1: EMA Crossover
   * EMA9 crosses EMA21 → trend change signal
   */
  private checkEMACrossover(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    if (candles.length < 3) return null;

    const currentPrice = candles[candles.length - 1].close;
    const prevCandle = candles[candles.length - 2];

    // Simple approximation: check if price crossed EMA21 recently
    const prevClose = prevCandle.close;
    const { ema9, ema21, atr14 } = indicators;

    // Bullish crossover: EMA9 > EMA21 AND previous candle was below EMA21
    if (ema9 > ema21 && prevClose < ema21 && currentPrice > ema21) {
      const stopLoss = currentPrice - (atr14 * 1.5);
      const takeProfit = currentPrice + (atr14 * 3);
      const rr = (takeProfit - currentPrice) / (currentPrice - stopLoss);

      return this.createSignal(symbol, candles, indicators, regime, 'LONG', stopLoss, takeProfit, rr,
        `EMA crossover bullish. EMA9(${ema9.toFixed(0)}) > EMA21(${ema21.toFixed(0)}), RSI: ${indicators.rsi14.toFixed(1)}`
      );
    }

    // Bearish crossover: EMA9 < EMA21 AND previous candle was above EMA21
    if (ema9 < ema21 && prevClose > ema21 && currentPrice < ema21) {
      const stopLoss = currentPrice + (atr14 * 1.5);
      const takeProfit = currentPrice - (atr14 * 3);
      const rr = (currentPrice - takeProfit) / (stopLoss - currentPrice);

      return this.createSignal(symbol, candles, indicators, regime, 'SHORT', stopLoss, takeProfit, rr,
        `EMA crossover bearish. EMA9(${ema9.toFixed(0)}) < EMA21(${ema21.toFixed(0)}), RSI: ${indicators.rsi14.toFixed(1)}`
      );
    }

    return null;
  }

  /**
   * STRATEGY 2: RSI Reversal
   * RSI oversold (<30) → LONG, RSI overbought (>70) → SHORT
   */
  private checkRSIReversal(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    const currentPrice = candles[candles.length - 1].close;
    const { rsi14, atr14, ema21 } = indicators;

    // RSI oversold reversal → LONG
    if (rsi14 < 48) {
      const stopLoss = currentPrice - (atr14 * 1.5);
      const takeProfit = currentPrice + (atr14 * 2.5);
      const rr = (takeProfit - currentPrice) / (currentPrice - stopLoss);

      return this.createSignal(symbol, candles, indicators, regime, 'LONG', stopLoss, takeProfit, rr,
        `RSI oversold reversal. RSI: ${rsi14.toFixed(1)}, bounce confirmed`
      );
    }

    // RSI overbought reversal → SHORT
    if (rsi14 > 52) {
      const stopLoss = currentPrice + (atr14 * 1.5);
      const takeProfit = currentPrice - (atr14 * 2.5);
      const rr = (currentPrice - takeProfit) / (stopLoss - currentPrice);

      return this.createSignal(symbol, candles, indicators, regime, 'SHORT', stopLoss, takeProfit, rr,
        `RSI overbought reversal. RSI: ${rsi14.toFixed(1)}, rejection confirmed`
      );
    }

    return null;
  }

  /**
   * STRATEGY 3: Momentum Breakout
   * Strong volume + directional move + ADX confirms trend
   */
  private checkMomentumBreakout(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    if (candles.length < 5) return null;

    const current = candles[candles.length - 1];
    const { atr14, volumeRatio, adx14, ema9, ema21 } = indicators;

    // Need decent volume
    if (volumeRatio < 0.8) return null;

    const bodySize = Math.abs(current.close - current.open);
    const candleRange = current.high - current.low;
    const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;

    // Need a strong candle (body > 45% of range)
    if (bodyRatio < 0.3) return null;

    // Bullish momentum: green candle + price > EMA9
    if (current.close > current.open && current.close > ema9) {
      const stopLoss = current.low - (atr14 * 0.5);
      const takeProfit = current.close + (atr14 * 2);
      const rr = (takeProfit - current.close) / (current.close - stopLoss);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'LONG', stopLoss, takeProfit, rr,
          `Momentum breakout LONG. Vol: ${volumeRatio.toFixed(1)}x, Body: ${(bodyRatio * 100).toFixed(0)}%, ADX: ${adx14.toFixed(1)}`
        );
      }
    }

    // Bearish momentum: red candle + price < EMA9
    if (current.close < current.open && current.close < ema9) {
      const stopLoss = current.high + (atr14 * 0.5);
      const takeProfit = current.close - (atr14 * 2);
      const rr = (current.close - takeProfit) / (stopLoss - current.close);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'SHORT', stopLoss, takeProfit, rr,
          `Momentum breakout SHORT. Vol: ${volumeRatio.toFixed(1)}x, Body: ${(bodyRatio * 100).toFixed(0)}%, ADX: ${adx14.toFixed(1)}`
        );
      }
    }

    return null;
  }

  /**
   * STRATEGY 4: Structure Break (original, loosened conditions)
   */
  private checkStructureBreak(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    if (candles.length < 20) return null;

    const currentPrice = candles[candles.length - 1].close;
    const { ema21, atr14, rsi14, adx14 } = indicators;

    // Recent highs/lows
    const recent = candles.slice(-10);
    const previous = candles.slice(-20, -10);
    const recentHigh = Math.max(...recent.map(c => c.high));
    const recentLow = Math.min(...recent.map(c => c.low));
    const prevHigh = Math.max(...previous.map(c => c.high));
    const prevLow = Math.min(...previous.map(c => c.low));

    // Bullish break: higher high + price above EMA21
    if (recentHigh > prevHigh && currentPrice > ema21 && rsi14 < 72) {
      const stopLoss = recentLow - (atr14 * 0.3);
      const takeProfit = currentPrice + (atr14 * 2.5);
      const rr = (takeProfit - currentPrice) / (currentPrice - stopLoss);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'LONG', stopLoss, takeProfit, rr,
          `Structure break bullish. New high: ${recentHigh.toFixed(0)} > ${prevHigh.toFixed(0)}, RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    // Bearish break: lower low + price below EMA21
    if (recentLow < prevLow && currentPrice < ema21 && rsi14 > 28) {
      const stopLoss = recentHigh + (atr14 * 0.3);
      const takeProfit = currentPrice - (atr14 * 2.5);
      const rr = (currentPrice - takeProfit) / (stopLoss - currentPrice);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'SHORT', stopLoss, takeProfit, rr,
          `Structure break bearish. New low: ${recentLow.toFixed(0)} < ${prevLow.toFixed(0)}, RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    return null;
  }

  /**
   * STRATEGY 5: EMA Bounce (Range Market)
   * Price bounces off EMA21 in a range → trade the bounce
   */
  private checkEMABounce(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    if (candles.length < 5) return null;

    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const { ema21, atr14, rsi14 } = indicators;

    // Only in non-trending conditions (RSI between 35-65)
    if (rsi14 < 20 || rsi14 > 80) return null;

    const distanceToEMA = Math.abs(current.close - ema21);
    const proximityThreshold = atr14 * 1.5;

    // Price must be near EMA21
    if (distanceToEMA > proximityThreshold) return null;

    // Bullish bounce: price was below EMA21, now closing above or near it
    if (prev.close < ema21 && current.close >= ema21 * 0.999) {
      const stopLoss = current.low - (atr14 * 0.8);
      const takeProfit = current.close + (atr14 * 1.8);
      const rr = (takeProfit - current.close) / (current.close - stopLoss);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'LONG', stopLoss, takeProfit, rr,
          `EMA bounce bullish. Price near EMA21(${ema21.toFixed(0)}), RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    // Bearish bounce: price was above EMA21, now closing below or near it
    if (prev.close > ema21 && current.close <= ema21 * 1.001) {
      const stopLoss = current.high + (atr14 * 0.8);
      const takeProfit = current.close - (atr14 * 1.8);
      const rr = (current.close - takeProfit) / (stopLoss - current.close);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'SHORT', stopLoss, takeProfit, rr,
          `EMA bounce bearish. Price near EMA21(${ema21.toFixed(0)}), RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    return null;
  }

  /**
   * STRATEGY 6: Mean Reversion
   * Price deviates too far from EMA50 → expect reversion back
   */
  private checkMeanReversion(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    if (candles.length < 10) return null;

    const current = candles[candles.length - 1];
    const { ema50, atr14, rsi14, ema21 } = indicators;

    // Distance from EMA50
    const deviation = current.close - ema50;
    const deviationATR = Math.abs(deviation) / atr14;

    // Need significant deviation (> 1.5 ATR from EMA50)
    if (deviationATR < 1.0) return null;

    // Bullish mean reversion: price far below EMA50 + RSI showing oversold tendency
    if (deviation < 0 && rsi14 < 45 && current.close > candles[candles.length - 2].close) {
      const stopLoss = current.close - (atr14 * 1.2);
      const targetDistance = Math.abs(deviation) * 0.5; // Target 50% reversion
      const takeProfit = current.close + targetDistance;
      const rr = targetDistance / (current.close - stopLoss);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'LONG', stopLoss, takeProfit, rr,
          `Mean reversion LONG. ${deviationATR.toFixed(1)}x ATR below EMA50(${ema50.toFixed(0)}), RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    // Bearish mean reversion: price far above EMA50 + RSI showing overbought tendency
    if (deviation > 0 && rsi14 > 55 && current.close < candles[candles.length - 2].close) {
      const stopLoss = current.close + (atr14 * 1.2);
      const targetDistance = Math.abs(deviation) * 0.5; // Target 50% reversion
      const takeProfit = current.close - targetDistance;
      const rr = targetDistance / (stopLoss - current.close);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'SHORT', stopLoss, takeProfit, rr,
          `Mean reversion SHORT. ${deviationATR.toFixed(1)}x ATR above EMA50(${ema50.toFixed(0)}), RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    return null;
  }

  /**
   * STRATEGY 7: Candle Trend (Catch-all)
   * Simple directional candle with any EMA support → trade the direction
   * This is the most aggressive strategy - fires when others don't
   */
  private checkCandleTrend(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    if (candles.length < 3) return null;

    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];
    const { ema9, ema21, atr14, rsi14 } = indicators;

    // Bullish: 2 consecutive green candles OR price recovering from dip
    const bullish = (current.close > current.open && prev.close > prev.open) ||
                    (current.close > prev.close && prev.close < prev2.close);

    if (bullish && rsi14 < 70) {
      const stopLoss = Math.min(current.low, prev.low) - (atr14 * 0.3);
      const takeProfit = current.close + (atr14 * 1.5);
      const rr = (takeProfit - current.close) / (current.close - stopLoss);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'LONG', stopLoss, takeProfit, rr,
          `Candle trend LONG. Consecutive green candles, RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    // Bearish: 2 consecutive red candles OR price rejecting from high
    const bearish = (current.close < current.open && prev.close < prev.open) ||
                    (current.close < prev.close && prev.close > prev2.close);

    if (bearish && rsi14 > 30) {
      const stopLoss = Math.max(current.high, prev.high) + (atr14 * 0.3);
      const takeProfit = current.close - (atr14 * 1.5);
      const rr = (current.close - takeProfit) / (stopLoss - current.close);

      if (rr >= 0.5) {
        return this.createSignal(symbol, candles, indicators, regime, 'SHORT', stopLoss, takeProfit, rr,
          `Candle trend SHORT. Consecutive red candles, RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    return null;
  }

  /**
   * STRATEGY 8: Quick Scalp (Ultra-Aggressive Catch-All)
   * Any directional candle with minimal confirmation → scalp the move
   * Tight stops, tight targets, high frequency
   */
  private checkQuickScalp(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    if (candles.length < 2) return null;

    const current = candles[candles.length - 1];
    const { ema9, atr14, rsi14, volumeRatio } = indicators;

    const bodySize = Math.abs(current.close - current.open);
    const minBody = atr14 * 0.15;

    // Skip doji / no-body candles
    if (bodySize < minBody) return null;

    // Bullish scalp: green candle, price above or near EMA9
    if (current.close > current.open && current.close >= ema9 * 0.998) {
      const stopLoss = current.low - (atr14 * 0.3);
      const takeProfit = current.close + (atr14 * 1.0);
      const rr = (takeProfit - current.close) / (current.close - stopLoss);

      if (rr >= 0.4) {
        return this.createSignal(symbol, candles, indicators, regime, 'LONG', stopLoss, takeProfit, rr,
          `Quick scalp LONG. Body: ${bodySize.toFixed(2)}, Vol: ${volumeRatio.toFixed(1)}x, RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    // Bearish scalp: red candle, price below or near EMA9
    if (current.close < current.open && current.close <= ema9 * 1.002) {
      const stopLoss = current.high + (atr14 * 0.3);
      const takeProfit = current.close - (atr14 * 1.0);
      const rr = (current.close - takeProfit) / (stopLoss - current.close);

      if (rr >= 0.4) {
        return this.createSignal(symbol, candles, indicators, regime, 'SHORT', stopLoss, takeProfit, rr,
          `Quick scalp SHORT. Body: ${bodySize.toFixed(2)}, Vol: ${volumeRatio.toFixed(1)}x, RSI: ${rsi14.toFixed(1)}`
        );
      }
    }

    return null;
  }

  // === Helpers ===

  private canTrade(symbol: string, candles: Candle[]): boolean {
    // Zero cooldown - always ready to trade
    return true;
  }

  private updateLastSignalTime(symbol: string, candles: Candle[]): void {
    this.lastSignalTime.set(symbol, candles[candles.length - 1].openTime);
  }

  private calculateStrength(indicators: Indicators): SignalStrength {
    const { adx14, volumeRatio, ema9, ema21, ema50 } = indicators;
    const emasAligned =
      (ema9 > ema21 && ema21 > ema50) ||
      (ema9 < ema21 && ema21 < ema50);

    if (adx14 > 25 && volumeRatio > 1.5 && emasAligned) return 'strong';
    if (adx14 > 15 || volumeRatio > 1.2) return 'moderate';
    return 'weak';
  }

  private createSignal(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState,
    direction: 'LONG' | 'SHORT',
    stopLoss: number,
    takeProfit: number,
    rr: number,
    reason: string
  ): TradeSignal {
    const currentPrice = candles[candles.length - 1].close;
    const strength = this.calculateStrength(indicators);

    const signal: TradeSignal = {
      id: randomUUID(),
      symbol,
      timestamp: candles[candles.length - 1].closeTime,
      direction,
      strength,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: rr,
      reason,
      indicators,
      regime,
    };

    logger.signal(symbol, direction, {
      strategy: reason.split('.')[0],
      strength,
      entry: currentPrice,
      stop: stopLoss,
      target: takeProfit,
      rr: rr.toFixed(2),
    });

    return signal;
  }
}
