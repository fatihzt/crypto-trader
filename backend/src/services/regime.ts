import { Indicators, RegimeState, VolatilityRegime, TrendRegime, MarketDecision } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class RegimeService {
  evaluate(symbol: string, indicators: Indicators, fearGreedIndex: number, currentPrice?: number): RegimeState {
    const timestamp = Date.now();

    // Classify volatility based on ATR%
    const volatility = this.classifyVolatility(indicators.atrPercent);

    // Classify trend based on EMA alignment and ADX
    const trend = this.classifyTrend(indicators, currentPrice);

    // Make market decision
    const decision = this.makeDecision(volatility, trend, fearGreedIndex);

    // Generate human-readable reason
    const reason = this.generateReason(volatility, trend, decision, indicators, fearGreedIndex);

    // Get fear/greed label
    const fearGreedLabel = this.getFearGreedLabel(fearGreedIndex);

    const regimeState: RegimeState = {
      symbol,
      timestamp,
      volatility,
      trend,
      decision,
      fearGreedIndex,
      fearGreedLabel,
      reason,
    };

    logger.regime(symbol, decision, {
      volatility,
      trend,
      atrPercent: indicators.atrPercent.toFixed(2),
      adx: indicators.adx14.toFixed(2),
      rsi: indicators.rsi14.toFixed(2),
      fearGreed: fearGreedIndex,
    });

    return regimeState;
  }

  private classifyVolatility(atrPercent: number): VolatilityRegime {
    if (atrPercent < 0.5) {
      return 'low';
    } else if (atrPercent < 2.5) {
      return 'normal';
    } else if (atrPercent < 5.0) {
      return 'high';
    } else {
      return 'extreme';
    }
  }

  private classifyTrend(indicators: Indicators, price?: number): TrendRegime {
    const { ema9, ema21, ema50, adx14 } = indicators;
    const currentPrice = price ?? indicators.ema9;

    // Strong uptrend: price > ema9 > ema21 > ema50 AND adx > 25
    if (currentPrice > ema9 && ema9 > ema21 && ema21 > ema50 && adx14 > 25) {
      return 'strong_up';
    }

    // Uptrend: price > ema21 AND ema9 > ema21
    if (currentPrice > ema21 && ema9 > ema21) {
      return 'up';
    }

    // Strong downtrend: price < ema9 < ema21 < ema50 AND adx > 25
    if (currentPrice < ema9 && ema9 < ema21 && ema21 < ema50 && adx14 > 25) {
      return 'strong_down';
    }

    // Downtrend: price < ema21 AND ema9 < ema21
    if (currentPrice < ema21 && ema9 < ema21) {
      return 'down';
    }

    // Neutral: EMAs are aligned (within 0.3%) OR adx < 15
    const emaAlignment = Math.abs(ema9 - ema21) / ema21;
    if (emaAlignment < 0.003 || adx14 < 15) {
      return 'neutral';
    }

    // Default to neutral if unclear
    return 'neutral';
  }

  private makeDecision(
    volatility: VolatilityRegime,
    trend: TrendRegime,
    fearGreedIndex: number
  ): MarketDecision {
    // DANGER only on extreme volatility with extreme fear
    if (volatility === 'extreme' && fearGreedIndex < 10) {
      return 'DANGER';
    }

    // Everything else: TRADE_ALLOWED (aggressive mode)
    return 'TRADE_ALLOWED';
  }

  private generateReason(
    volatility: VolatilityRegime,
    trend: TrendRegime,
    decision: MarketDecision,
    indicators: Indicators,
    fearGreedIndex: number
  ): string {
    const parts: string[] = [];

    // Volatility description
    if (volatility === 'extreme') {
      parts.push(`Extreme volatility (ATR ${indicators.atrPercent.toFixed(2)}%)`);
    } else if (volatility === 'high') {
      parts.push(`High volatility (ATR ${indicators.atrPercent.toFixed(2)}%)`);
    } else if (volatility === 'low') {
      parts.push(`Low volatility (ATR ${indicators.atrPercent.toFixed(2)}%)`);
    } else {
      parts.push(`Normal volatility (ATR ${indicators.atrPercent.toFixed(2)}%)`);
    }

    // Trend description
    if (trend === 'strong_up') {
      parts.push(`strong uptrend (ADX ${indicators.adx14.toFixed(1)})`);
    } else if (trend === 'up') {
      parts.push(`uptrend`);
    } else if (trend === 'strong_down') {
      parts.push(`strong downtrend (ADX ${indicators.adx14.toFixed(1)})`);
    } else if (trend === 'down') {
      parts.push(`downtrend`);
    } else {
      parts.push(`no clear trend (ADX ${indicators.adx14.toFixed(1)})`);
    }

    // Momentum description
    if (indicators.rsi14 > 70) {
      parts.push(`overbought (RSI ${indicators.rsi14.toFixed(1)})`);
    } else if (indicators.rsi14 < 30) {
      parts.push(`oversold (RSI ${indicators.rsi14.toFixed(1)})`);
    }

    // Fear/Greed context
    if (fearGreedIndex < 20) {
      parts.push(`extreme fear (${fearGreedIndex})`);
    } else if (fearGreedIndex > 80) {
      parts.push(`extreme greed (${fearGreedIndex})`);
    }

    // Decision reasoning
    let decisionReason = '';
    if (decision === 'DANGER') {
      decisionReason = 'DANGER - Risk too high to trade';
    } else if (decision === 'WAIT') {
      decisionReason = 'WAIT - No clear edge';
    } else {
      decisionReason = 'TRADE_ALLOWED - Conditions acceptable';
    }

    return `${decisionReason}. ${parts.join(', ')}.`;
  }

  private getFearGreedLabel(index: number): string {
    if (index <= 20) {
      return 'Extreme Fear';
    } else if (index <= 40) {
      return 'Fear';
    } else if (index <= 60) {
      return 'Neutral';
    } else if (index <= 80) {
      return 'Greed';
    } else {
      return 'Extreme Greed';
    }
  }
}
