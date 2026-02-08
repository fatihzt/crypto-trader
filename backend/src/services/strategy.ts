// ============================================
// STRATEGY SERVICE
// Structure-Break + Trend Following Strategy
// ============================================

import { randomUUID } from 'crypto';
import type {
  TradingConfig,
  Candle,
  Indicators,
  RegimeState,
  TradeSignal,
  SignalDirection,
  SignalStrength,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

interface SwingPoints {
  lastSwingHigh: number;
  lastSwingLow: number;
  currentHigh: number;
  currentLow: number;
  previousSwingHigh: number;
  previousSwingLow: number;
}

interface StructureAnalysis {
  isBullishBreak: boolean;
  isBearishBreak: boolean;
  swingPoints: SwingPoints;
}

export class StrategyService {
  private config: TradingConfig;
  private lastSignalTime: Map<string, number> = new Map();

  constructor(config: TradingConfig) {
    this.config = config;
    logger.info('Strategy', 'Structure-Break strategy initialized', {
      cooldownCandles: config.cooldownCandles,
      riskPerTrade: config.riskPerTradePercent,
    });
  }

  /**
   * Evaluate market conditions and generate trade signal if conditions met
   */
  public evaluate(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    regime: RegimeState
  ): TradeSignal | null {
    // Rule 1: Only trade when regime allows
    if (regime.decision !== 'TRADE_ALLOWED') {
      return null;
    }

    // Check cooldown period
    if (!this.canTrade(symbol, candles)) {
      return null;
    }

    // Analyze market structure
    const structure = this.analyzeStructure(candles, indicators);

    // Check for LONG signal
    const longSignal = this.checkLongConditions(symbol, candles, indicators, structure, regime);
    if (longSignal) {
      this.updateLastSignalTime(symbol, candles);
      return longSignal;
    }

    // Check for SHORT signal
    const shortSignal = this.checkShortConditions(symbol, candles, indicators, structure, regime);
    if (shortSignal) {
      this.updateLastSignalTime(symbol, candles);
      return shortSignal;
    }

    return null;
  }

  /**
   * Check if enough time has passed since last signal (cooldown)
   */
  private canTrade(symbol: string, candles: Candle[]): boolean {
    const lastTime = this.lastSignalTime.get(symbol);
    if (!lastTime) return true;

    const currentTime = candles[candles.length - 1].openTime;
    const candlesSince = Math.floor((currentTime - lastTime) / (15 * 60 * 1000)); // Assuming 15m candles

    return candlesSince >= this.config.cooldownCandles;
  }

  /**
   * Update last signal time for a symbol
   */
  private updateLastSignalTime(symbol: string, candles: Candle[]): void {
    this.lastSignalTime.set(symbol, candles[candles.length - 1].openTime);
  }

  /**
   * Analyze market structure to detect breaks
   */
  private analyzeStructure(candles: Candle[], indicators: Indicators): StructureAnalysis {
    if (candles.length < 20) {
      return {
        isBullishBreak: false,
        isBearishBreak: false,
        swingPoints: {
          lastSwingHigh: indicators.lastSwingHigh,
          lastSwingLow: indicators.lastSwingLow,
          currentHigh: 0,
          currentLow: 0,
          previousSwingHigh: 0,
          previousSwingLow: 0,
        },
      };
    }

    // Get recent price action (last 10 candles for current structure)
    const recentCandles = candles.slice(-10);
    const currentHigh = Math.max(...recentCandles.map(c => c.high));
    const currentLow = Math.min(...recentCandles.map(c => c.low));

    // Get previous swing points (10-20 candles back)
    const previousCandles = candles.slice(-20, -10);
    const previousSwingHigh = Math.max(...previousCandles.map(c => c.high));
    const previousSwingLow = Math.min(...previousCandles.map(c => c.low));

    // BULLISH structure break: current low > previous low AND current high > previous high
    const isBullishBreak = currentLow > previousSwingLow && currentHigh > previousSwingHigh;

    // BEARISH structure break: current high < previous high AND current low < previous low
    const isBearishBreak = currentHigh < previousSwingHigh && currentLow < previousSwingLow;

    return {
      isBullishBreak,
      isBearishBreak,
      swingPoints: {
        lastSwingHigh: indicators.lastSwingHigh,
        lastSwingLow: indicators.lastSwingLow,
        currentHigh,
        currentLow,
        previousSwingHigh,
        previousSwingLow,
      },
    };
  }

  /**
   * Check all conditions for LONG signal
   */
  private checkLongConditions(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    structure: StructureAnalysis,
    regime: RegimeState
  ): TradeSignal | null {
    const currentPrice = candles[candles.length - 1].close;

    // All conditions must be true
    const conditions = {
      structureBreak: structure.isBullishBreak,
      rsiMomentum: indicators.rsi14 > 40 && indicators.rsi14 < 70,
      priceAboveEma: currentPrice > indicators.ema21,
      volumeConfirm: indicators.volumeRatio > 1.0,
      trendExists: indicators.adx14 > 15,
    };

    if (!Object.values(conditions).every(Boolean)) {
      return null;
    }

    // Calculate stop-loss and take-profit
    const stopLoss = structure.swingPoints.lastSwingLow;
    const stopDistance = Math.abs(currentPrice - stopLoss);
    const takeProfit = currentPrice + (stopDistance * 2); // 2:1 R:R minimum
    const riskRewardRatio = 2.0;

    // Determine signal strength
    const strength = this.calculateStrength(indicators);

    // Check if EMAs are aligned (bullish)
    const emasAligned = indicators.ema9 > indicators.ema21 && indicators.ema21 > indicators.ema50;

    const signal: TradeSignal = {
      id: randomUUID(),
      symbol,
      timestamp: candles[candles.length - 1].closeTime,
      direction: 'LONG',
      strength,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio,
      reason: `Bullish structure break detected. RSI: ${indicators.rsi14.toFixed(1)}, ADX: ${indicators.adx14.toFixed(1)}, Vol Ratio: ${indicators.volumeRatio.toFixed(2)}, EMAs aligned: ${emasAligned}`,
      indicators,
      regime,
    };

    logger.signal(symbol, 'LONG', {
      strength,
      entry: currentPrice,
      stop: stopLoss,
      target: takeProfit,
      rr: riskRewardRatio,
    });

    return signal;
  }

  /**
   * Check all conditions for SHORT signal
   */
  private checkShortConditions(
    symbol: string,
    candles: Candle[],
    indicators: Indicators,
    structure: StructureAnalysis,
    regime: RegimeState
  ): TradeSignal | null {
    const currentPrice = candles[candles.length - 1].close;

    // All conditions must be true
    const conditions = {
      structureBreak: structure.isBearishBreak,
      rsiMomentum: indicators.rsi14 < 60 && indicators.rsi14 > 30,
      priceBelowEma: currentPrice < indicators.ema21,
      volumeConfirm: indicators.volumeRatio > 1.0,
      trendExists: indicators.adx14 > 15,
    };

    if (!Object.values(conditions).every(Boolean)) {
      return null;
    }

    // Calculate stop-loss and take-profit
    const stopLoss = structure.swingPoints.lastSwingHigh;
    const stopDistance = Math.abs(stopLoss - currentPrice);
    const takeProfit = currentPrice - (stopDistance * 2); // 2:1 R:R minimum
    const riskRewardRatio = 2.0;

    // Determine signal strength
    const strength = this.calculateStrength(indicators);

    // Check if EMAs are aligned (bearish)
    const emasAligned = indicators.ema9 < indicators.ema21 && indicators.ema21 < indicators.ema50;

    const signal: TradeSignal = {
      id: randomUUID(),
      symbol,
      timestamp: candles[candles.length - 1].closeTime,
      direction: 'SHORT',
      strength,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio,
      reason: `Bearish structure break detected. RSI: ${indicators.rsi14.toFixed(1)}, ADX: ${indicators.adx14.toFixed(1)}, Vol Ratio: ${indicators.volumeRatio.toFixed(2)}, EMAs aligned: ${emasAligned}`,
      indicators,
      regime,
    };

    logger.signal(symbol, 'SHORT', {
      strength,
      entry: currentPrice,
      stop: stopLoss,
      target: takeProfit,
      rr: riskRewardRatio,
    });

    return signal;
  }

  /**
   * Calculate signal strength based on ADX, volume, and EMA alignment
   */
  private calculateStrength(indicators: Indicators): SignalStrength {
    const { adx14, volumeRatio, ema9, ema21, ema50 } = indicators;

    // Check EMA alignment (either bullish or bearish)
    const emasAligned =
      (ema9 > ema21 && ema21 > ema50) || // Bullish alignment
      (ema9 < ema21 && ema21 < ema50);   // Bearish alignment

    // Strong: High trend strength + high volume + aligned EMAs
    if (adx14 > 30 && volumeRatio > 1.5 && emasAligned) {
      return 'strong';
    }

    // Moderate: Good trend or good volume
    if (adx14 > 20 || volumeRatio > 1.2) {
      return 'moderate';
    }

    // Weak: Minimum requirements met
    return 'weak';
  }
}
