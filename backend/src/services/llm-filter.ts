// ============================================
// LLM FILTER SERVICE - OpenAI GPT-4o-mini
// ============================================

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { TradeSignal, NewsItem, LLMFilterResult, ClosedTrade, LLMDecision } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

interface LLMResponse {
  decision: LLMDecision;
  confidence: number;
  reasoning: string;
  delayMinutes?: number | null;
}

export class LLMFilterService {
  private openai: OpenAI;
  private lastCallTimestamp = 0;
  private readonly MIN_CALL_INTERVAL = 2000; // 2 seconds between calls

  constructor() {
    this.openai = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
    });
  }

  /**
   * Rate limiting: ensure minimum 2 seconds between API calls
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTimestamp;

    if (timeSinceLastCall < this.MIN_CALL_INTERVAL) {
      const waitTime = this.MIN_CALL_INTERVAL - timeSinceLastCall;
      logger.info('LLMFilterService', `Rate limiting: waiting ${waitTime}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastCallTimestamp = Date.now();
  }

  /**
   * Evaluate a trade signal using LLM with market context
   */
  async evaluateSignal(
    signal: TradeSignal,
    news: NewsItem[],
    fearGreed: { value: number; label: string }
  ): Promise<LLMFilterResult> {
    await this.rateLimit();

    const systemPrompt = `You are a senior crypto trading risk analyst. Your job is to evaluate whether a trading signal should be executed NOW given current market context. You must respond with a JSON object.

Your decision options:
- APPROVE: Execute the trade immediately
- REJECT: Do not execute the trade at all
- DELAY: Wait before executing (specify minutes)

Consider:
- Signal strength and technical setup quality
- Market regime (volatility, trend strength)
- Fear & Greed Index (extreme readings = caution)
- Recent news sentiment and potential catalysts
- Risk/Reward ratio
- Time of day (avoid major event times like US market open/close, FOMC)

Respond ONLY with valid JSON in this exact format:
{
  "decision": "APPROVE" | "REJECT" | "DELAY",
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentence explanation",
  "delayMinutes": number or null
}`;

    const userPrompt = this.buildSignalPrompt(signal, news, fearGreed);

    try {
      logger.llm('Evaluating signal', { signalId: signal.id, symbol: signal.symbol, direction: signal.direction });

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.3, // Lower temperature for more consistent decisions
        max_tokens: 500,
        response_format: { type: 'json_object' },
      });

      const responseText = completion.choices[0]?.message?.content;
      if (!responseText) {
        throw new Error('Empty response from OpenAI');
      }

      const llmResponse: LLMResponse = JSON.parse(responseText);

      // Validate response structure
      if (!llmResponse.decision || typeof llmResponse.confidence !== 'number' || !llmResponse.reasoning) {
        throw new Error('Invalid LLM response structure');
      }

      const result: LLMFilterResult = {
        signalId: signal.id,
        decision: llmResponse.decision,
        confidence: Math.max(0, Math.min(1, llmResponse.confidence)), // Clamp 0-1
        reasoning: llmResponse.reasoning,
        delayMinutes: llmResponse.delayMinutes ?? undefined,
        newsContext: news.slice(0, 10).map((n) => n.title),
        timestamp: Date.now(),
      };

      logger.llm('Signal evaluation complete', {
        decision: result.decision,
        confidence: result.confidence,
        hasDelay: result.delayMinutes !== undefined,
      });

      return result;
    } catch (error) {
      logger.error('LLMFilterService', 'Failed to evaluate signal, defaulting to APPROVE', error);

      // Default to APPROVE with low confidence on error
      return {
        signalId: signal.id,
        decision: 'APPROVE',
        confidence: 0.5,
        reasoning: `LLM evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}. Proceeding with caution.`,
        newsContext: news.slice(0, 10).map((n) => n.title),
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Analyze a closed trade and provide learning insights (in Turkish)
   */
  async analyzeClosedTrade(trade: ClosedTrade): Promise<string> {
    await this.rateLimit();

    const systemPrompt = `Sen deneyimli bir kripto trading analisti olarak, kapatılmış bir işlemi değerlendiriyorsun. Neyin doğru/yanlış gittiğini ve neler öğrenebileceğimizi 2-3 cümlede açıkla. Türkçe cevap ver.`;

    const userPrompt = `
İşlem Özeti:
- Sembol: ${trade.symbol}
- Yön: ${trade.direction}
- Giriş Fiyatı: $${trade.entryPrice.toFixed(2)}
- Çıkış Fiyatı: $${trade.exitPrice.toFixed(2)}
- Kar/Zarar: $${trade.pnl.toFixed(2)} (${trade.pnlPercent.toFixed(2)}%)
- Süre: ${((trade.exitTime - trade.entryTime) / 1000 / 60).toFixed(0)} dakika
- Çıkış Nedeni: ${trade.exitReason}
- Sonuç: ${trade.outcome}
- Piyasa Rejimi (Giriş): ${trade.llmApproval?.reasoning || 'N/A'}

Bu işlemden neler öğrenebiliriz? Kısa ve net açıkla.
`;

    try {
      logger.llm('Analyzing closed trade', { tradeId: trade.id, outcome: trade.outcome, pnlPercent: trade.pnlPercent });

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.5,
        max_tokens: 300,
      });

      const analysis = completion.choices[0]?.message?.content || '';

      if (!analysis) {
        throw new Error('Empty analysis from OpenAI');
      }

      logger.llm('Trade analysis complete', { tradeId: trade.id });
      return analysis.trim();
    } catch (error) {
      logger.error('LLMFilterService', 'Failed to analyze closed trade', error);
      return `Analiz yapılamadı: ${error instanceof Error ? error.message : 'Bilinmeyen hata'}. Manuel inceleme gerekiyor.`;
    }
  }

  /**
   * Build comprehensive prompt for signal evaluation
   */
  private buildSignalPrompt(
    signal: TradeSignal,
    news: NewsItem[],
    fearGreed: { value: number; label: string }
  ): string {
    const currentTime = new Date();
    const indicators = signal.indicators;
    const regime = signal.regime;

    // Format news headlines
    const newsSection = news.length > 0
      ? news
          .slice(0, 10)
          .map((n, i) => `${i + 1}. [${n.sentiment.toUpperCase()}] ${n.title} (${n.source})`)
          .join('\n')
      : 'No recent news available';

    return `
CURRENT TIME: ${currentTime.toISOString()} (UTC)

=== TRADE SIGNAL ===
Symbol: ${signal.symbol}
Direction: ${signal.direction}
Strength: ${signal.strength}
Entry Price: $${signal.entryPrice.toFixed(2)}
Stop Loss: $${signal.stopLoss.toFixed(2)}
Take Profit: $${signal.takeProfit.toFixed(2)}
Risk/Reward Ratio: ${signal.riskRewardRatio.toFixed(2)}
Signal Reason: ${signal.reason}

=== TECHNICAL SNAPSHOT ===
RSI(14): ${indicators.rsi14.toFixed(2)}
ADX(14): ${indicators.adx14.toFixed(2)} (trend strength)
ATR %: ${indicators.atrPercent.toFixed(2)}%
EMA Alignment:
  - EMA(9): $${indicators.ema9.toFixed(2)}
  - EMA(21): $${indicators.ema21.toFixed(2)}
  - EMA(50): $${indicators.ema50.toFixed(2)}
Volume Ratio: ${indicators.volumeRatio.toFixed(2)}x (vs 20-period avg)

=== MARKET REGIME ===
Volatility: ${regime.volatility}
Trend: ${regime.trend}
Decision: ${regime.decision}
Regime Reason: ${regime.reason}

=== FEAR & GREED INDEX ===
Value: ${fearGreed.value}/100
Classification: ${fearGreed.label}

=== RECENT NEWS (Last 10 Headlines) ===
${newsSection}

=== YOUR TASK ===
Given all the above context, should this ${signal.direction} trade be executed NOW?
Consider:
1. Is the technical setup strong enough?
2. Does the market regime support this trade?
3. Are there any concerning news events or sentiment shifts?
4. Is the Fear & Greed Index at an extreme that warrants caution?
5. Is this a good time of day to enter a position?

Respond with your decision in JSON format.
`.trim();
  }
}
