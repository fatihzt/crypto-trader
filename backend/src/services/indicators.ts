import { Candle, Indicators } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class IndicatorService {
  calculate(symbol: string, candles: Candle[]): Indicators {
    const timestamp = Date.now();

    // Default indicators if not enough data
    if (candles.length < 2) {
      logger.warn('IndicatorService', `Not enough candles for ${symbol}, returning defaults`);
      return this.getDefaultIndicators(symbol, timestamp);
    }

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    return {
      symbol,
      timestamp,
      ema9: this.calculateEMA(closes, 9),
      ema21: this.calculateEMA(closes, 21),
      ema50: this.calculateEMA(closes, 50),
      rsi14: this.calculateRSI(closes, 14),
      atr14: this.calculateATR(highs, lows, closes, 14),
      atrPercent: this.calculateATRPercent(highs, lows, closes, 14),
      adx14: this.calculateADX(highs, lows, closes, 14),
      volumeSma20: this.calculateSMA(volumes, 20),
      volumeRatio: this.calculateVolumeRatio(volumes, 20),
      lastSwingHigh: this.findLastSwingHigh(candles, 5),
      lastSwingLow: this.findLastSwingLow(candles, 5),
    };
  }

  private getDefaultIndicators(symbol: string, timestamp: number): Indicators {
    return {
      symbol,
      timestamp,
      ema9: 0,
      ema21: 0,
      ema50: 0,
      rsi14: 50,
      atr14: 0,
      atrPercent: 0,
      adx14: 0,
      volumeSma20: 0,
      volumeRatio: 1,
      lastSwingHigh: 0,
      lastSwingLow: 0,
    };
  }

  // === EMA (Exponential Moving Average) ===
  private calculateEMA(data: number[], period: number): number {
    if (data.length < period) {
      return data.length > 0 ? data[data.length - 1] : 0;
    }

    const multiplier = 2 / (period + 1);

    // Start with SMA for first value
    let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

    // Calculate EMA for remaining values
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  // === SMA (Simple Moving Average) ===
  private calculateSMA(data: number[], period: number): number {
    if (data.length < period) {
      period = data.length;
    }

    if (period === 0) {
      return 0;
    }

    const slice = data.slice(-period);
    return slice.reduce((sum, val) => sum + val, 0) / period;
  }

  // === RSI (Relative Strength Index) - Wilder's smoothing ===
  private calculateRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) {
      return 50; // Neutral default
    }

    const changes: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    // Separate gains and losses
    const gains = changes.map(c => (c > 0 ? c : 0));
    const losses = changes.map(c => (c < 0 ? Math.abs(c) : 0));

    // Initial average gain/loss (SMA)
    let avgGain = gains.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

    // Wilder's smoothing for subsequent values
    for (let i = period; i < changes.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);

    return rsi;
  }

  // === ATR (Average True Range) ===
  private calculateATR(highs: number[], lows: number[], closes: number[], period: number): number {
    if (highs.length < period + 1) {
      return 0;
    }

    const trueRanges: number[] = [];

    for (let i = 1; i < highs.length; i++) {
      const high = highs[i];
      const low = lows[i];
      const prevClose = closes[i - 1];

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );

      trueRanges.push(tr);
    }

    // Use Wilder's smoothing (RMA)
    let atr = trueRanges.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

    for (let i = period; i < trueRanges.length; i++) {
      atr = (atr * (period - 1) + trueRanges[i]) / period;
    }

    return atr;
  }

  private calculateATRPercent(highs: number[], lows: number[], closes: number[], period: number): number {
    const atr = this.calculateATR(highs, lows, closes, period);
    const currentPrice = closes[closes.length - 1];

    if (currentPrice === 0) {
      return 0;
    }

    return (atr / currentPrice) * 100;
  }

  // === ADX (Average Directional Index) ===
  private calculateADX(highs: number[], lows: number[], closes: number[], period: number): number {
    if (highs.length < period + 1) {
      return 0;
    }

    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const trueRanges: number[] = [];

    // Calculate +DM, -DM, and TR
    for (let i = 1; i < highs.length; i++) {
      const highDiff = highs[i] - highs[i - 1];
      const lowDiff = lows[i - 1] - lows[i];

      plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
      minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trueRanges.push(tr);
    }

    // Smooth +DM, -DM, and TR using Wilder's smoothing
    let smoothPlusDM = plusDM.slice(0, period).reduce((sum, val) => sum + val, 0);
    let smoothMinusDM = minusDM.slice(0, period).reduce((sum, val) => sum + val, 0);
    let smoothTR = trueRanges.slice(0, period).reduce((sum, val) => sum + val, 0);

    for (let i = period; i < plusDM.length; i++) {
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
      smoothTR = smoothTR - smoothTR / period + trueRanges[i];
    }

    // Calculate +DI and -DI
    const plusDI = smoothTR !== 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR !== 0 ? (smoothMinusDM / smoothTR) * 100 : 0;

    // Calculate DX
    const diSum = plusDI + minusDI;
    const dx = diSum !== 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;

    // ADX is smoothed DX (we'll use the last DX value as a simplified version)
    // For a full implementation, we'd need to smooth DX over period
    return dx;
  }

  // === Volume Ratio ===
  private calculateVolumeRatio(volumes: number[], period: number): number {
    if (volumes.length < 2) {
      return 1;
    }

    const sma = this.calculateSMA(volumes, period);
    const currentVolume = volumes[volumes.length - 1];

    if (sma === 0) {
      return 1;
    }

    return currentVolume / sma;
  }

  // === Swing High (pivot high) ===
  private findLastSwingHigh(candles: Candle[], lookback: number): number {
    if (candles.length < lookback * 2 + 1) {
      return candles.length > 0 ? Math.max(...candles.map(c => c.high)) : 0;
    }

    // Look for pivot highs (high point with lower highs on both sides)
    for (let i = candles.length - 1 - lookback; i >= lookback; i--) {
      const currentHigh = candles[i].high;
      let isPivot = true;

      // Check left side
      for (let j = i - lookback; j < i; j++) {
        if (candles[j].high >= currentHigh) {
          isPivot = false;
          break;
        }
      }

      if (!isPivot) continue;

      // Check right side
      for (let j = i + 1; j <= i + lookback; j++) {
        if (candles[j].high >= currentHigh) {
          isPivot = false;
          break;
        }
      }

      if (isPivot) {
        return currentHigh;
      }
    }

    // No pivot found, return highest high
    return Math.max(...candles.map(c => c.high));
  }

  // === Swing Low (pivot low) ===
  private findLastSwingLow(candles: Candle[], lookback: number): number {
    if (candles.length < lookback * 2 + 1) {
      return candles.length > 0 ? Math.min(...candles.map(c => c.low)) : 0;
    }

    // Look for pivot lows (low point with higher lows on both sides)
    for (let i = candles.length - 1 - lookback; i >= lookback; i--) {
      const currentLow = candles[i].low;
      let isPivot = true;

      // Check left side
      for (let j = i - lookback; j < i; j++) {
        if (candles[j].low <= currentLow) {
          isPivot = false;
          break;
        }
      }

      if (!isPivot) continue;

      // Check right side
      for (let j = i + 1; j <= i + lookback; j++) {
        if (candles[j].low <= currentLow) {
          isPivot = false;
          break;
        }
      }

      if (isPivot) {
        return currentLow;
      }
    }

    // No pivot found, return lowest low
    return Math.min(...candles.map(c => c.low));
  }
}
