// ============================================
// TRADING ENGINE - Main Orchestrator
// ============================================

import { BinanceService } from './binance.js';
import { IndicatorService } from './indicators.js';
import { RegimeService } from './regime.js';
import { StrategyService } from './strategy.js';
import { PortfolioService } from './portfolio.js';
import { TraderService } from './trader.js';
import { NewsService } from './news.js';
import { LLMFilterService } from './llm-filter.js';
import { NotificationService } from './notification.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import type {
  DEFAULT_CONFIG,
  EngineState,
  EngineStatus,
  RegimeState,
  TradeSignal,
  LLMFilterResult,
  Candle,
} from '../types/index.js';
import { DEFAULT_CONFIG as CONFIG } from '../types/index.js';

export class TradingEngine {
  private status: EngineStatus = 'starting';
  private startedAt = 0;
  private errors: string[] = [];
  private lastPortfolioSnapshot = 0;
  private readonly PORTFOLIO_SNAPSHOT_INTERVAL = 15 * 60 * 1000; // 15 minutes

  // Services
  private binance: BinanceService;
  private indicators: IndicatorService;
  private regime: RegimeService;
  private strategy: StrategyService;
  private portfolio: PortfolioService;
  private trader: TraderService;
  private news: NewsService;
  private llm: LLMFilterService;
  private notify: NotificationService;

  // State tracking
  private regimes: Map<string, RegimeState> = new Map();
  private lastSignal: TradeSignal | null = null;
  private lastLLMDecision: LLMFilterResult | null = null;

  constructor() {
    logger.info('TradingEngine', 'Initializing trading engine');

    // Initialize all services
    this.binance = new BinanceService();
    this.indicators = new IndicatorService();
    this.regime = new RegimeService();
    this.strategy = new StrategyService(CONFIG);
    this.portfolio = new PortfolioService(CONFIG);
    this.trader = new TraderService(this.portfolio, CONFIG);
    this.news = new NewsService();
    this.llm = new LLMFilterService();
    this.notify = new NotificationService();

    logger.info('TradingEngine', 'All services initialized', {
      symbols: CONFIG.symbols,
      interval: CONFIG.interval,
      initialCapital: CONFIG.initialCapital,
    });
  }

  /**
   * Start the trading engine
   */
  async start(): Promise<void> {
    try {
      logger.info('TradingEngine', 'Starting trading engine...');
      this.status = 'starting';
      this.startedAt = Date.now();

      // Start Binance service
      await this.binance.start();

      // Register candle callback (main trading loop)
      this.binance.onCandle((candle) => {
        this.onCandleClosed(candle).catch((error) => {
          this.handleError('Candle processing error', error);
        });
      });

      this.status = 'running';
      logger.info('TradingEngine', 'Trading engine started successfully');

      // Notify engine started
      await this.notify.engineStarted();
    } catch (error) {
      this.status = 'error';
      this.handleError('Failed to start trading engine', error);
      throw error;
    }
  }

  /**
   * Stop the trading engine gracefully
   */
  async stop(): Promise<void> {
    try {
      logger.info('TradingEngine', 'Stopping trading engine...');

      // Stop Binance service
      await this.binance.stop();

      // Save final portfolio snapshot
      await this.savePortfolioSnapshot();

      logger.info('TradingEngine', 'Trading engine stopped successfully');
    } catch (error) {
      this.handleError('Error during shutdown', error);
    }
  }

  /**
   * Get current engine state
   */
  getState(): EngineState {
    const uptime = this.startedAt > 0 ? Date.now() - this.startedAt : 0;

    return {
      status: this.status,
      startedAt: this.startedAt,
      uptime,
      symbols: CONFIG.symbols,
      decisionInterval: CONFIG.interval,
      regimes: Object.fromEntries(this.regimes),
      portfolio: this.portfolio.getState(),
      lastSignal: this.lastSignal,
      lastLLMDecision: this.lastLLMDecision,
      errors: this.errors.slice(-10), // Last 10 errors
    };
  }

  /**
   * Main trading loop - triggered on each closed candle
   */
  private async onCandleClosed(candle: Candle): Promise<void> {
    const symbol = candle.symbol;

    try {
      logger.info('TradingEngine', `Processing closed candle for ${symbol}`, {
        time: new Date(candle.closeTime).toISOString(),
        close: candle.close,
      });

      // Step 1: Get recent candles for analysis
      const recentCandles = this.binance.getRecentCandles(symbol, 100);
      if (recentCandles.length < 50) {
        logger.warn('TradingEngine', `Not enough candles for ${symbol}, skipping`);
        return;
      }

      // Step 2: Calculate technical indicators
      const indicators = this.indicators.calculate(symbol, recentCandles);

      // Step 3: Get Fear & Greed Index
      const fearGreed = await this.news.getFearGreedIndex();

      // Step 4: Evaluate market regime
      const currentPrice = this.binance.getCurrentPrice(symbol);
      const regimeState = this.regime.evaluate(symbol, indicators, fearGreed.value, currentPrice);
      this.regimes.set(symbol, regimeState);

      // Step 5: Check for exits on existing positions (every candle)
      const prices: Record<string, number> = {};
      for (const sym of CONFIG.symbols) {
        prices[sym] = this.binance.getCurrentPrice(sym);
      }
      const closedTrades = this.trader.checkExits(prices);

      // Step 6: Run post-trade analysis for closed trades
      if (closedTrades.length > 0) {
        for (const trade of closedTrades) {
          try {
            const analysis = await this.llm.analyzeClosedTrade(trade);
            trade.postTradeAnalysis = analysis;

            // Save closed trade to Supabase
            await this.saveClosedTrade(trade);

            // Notify trade closed
            await this.notify.tradeClosed(trade);

            logger.info('TradingEngine', `Trade closed and analyzed: ${trade.symbol}`, {
              pnl: trade.pnl.toFixed(2),
              outcome: trade.outcome,
            });
          } catch (error) {
            this.handleError(`Failed to analyze closed trade ${trade.id}`, error);
          }
        }
      }

      // Step 7: Evaluate strategy for new signals (only if regime allows)
      if (regimeState.decision === 'TRADE_ALLOWED') {
        const signal = this.strategy.evaluate(symbol, recentCandles, indicators, regimeState);

        if (signal) {
          this.lastSignal = signal;

          // Notify signal generated
          await this.notify.signalGenerated(signal);

          // Step 8: Get latest news for LLM context
          const newsItems = await this.news.getLatestNews(symbol);

          // Step 9: Send to LLM filter for approval
          const llmDecision = await this.llm.evaluateSignal(signal, newsItems, fearGreed);
          this.lastLLMDecision = llmDecision;

          // Save signal and LLM decision to Supabase
          await this.saveSignal(signal);
          await this.saveLLMDecision(llmDecision);

          // Step 10: Execute trade if LLM approves
          if (llmDecision.decision === 'APPROVE') {
            const position = this.trader.executeTrade(signal, currentPrice);

            if (position) {
              // Notify trade opened
              await this.notify.tradeOpened(position, signal, llmDecision);

              logger.info('TradingEngine', `Trade executed: ${signal.direction} ${symbol}`, {
                positionId: position.id,
                price: currentPrice,
                llmConfidence: llmDecision.confidence,
              });
            }
          } else {
            // Notify trade rejected
            await this.notify.tradeRejected(signal, llmDecision);

            logger.info('TradingEngine', `Trade rejected by LLM: ${symbol}`, {
              decision: llmDecision.decision,
              reasoning: llmDecision.reasoning,
            });
          }
        }
      }

      // Step 11: Save portfolio snapshot periodically
      const now = Date.now();
      if (now - this.lastPortfolioSnapshot > this.PORTFOLIO_SNAPSHOT_INTERVAL) {
        await this.savePortfolioSnapshot();
        this.lastPortfolioSnapshot = now;
      }
    } catch (error) {
      this.handleError(`Error processing candle for ${symbol}`, error);
    }
  }

  /**
   * Save signal to Supabase
   */
  private async saveSignal(signal: TradeSignal): Promise<void> {
    try {
      const { error } = await supabase.from('signals').insert({
        id: signal.id,
        symbol: signal.symbol,
        direction: signal.direction,
        strength: signal.strength,
        entry_price: signal.entryPrice,
        stop_loss: signal.stopLoss,
        take_profit: signal.takeProfit,
        risk_reward_ratio: signal.riskRewardRatio,
        reason: signal.reason,
        indicators: signal.indicators,
        regime: signal.regime,
      });

      if (error) {
        throw error;
      }
    } catch (error) {
      this.handleError('Failed to save signal to Supabase', error);
    }
  }

  /**
   * Save LLM decision to Supabase
   */
  private async saveLLMDecision(decision: LLMFilterResult): Promise<void> {
    try {
      const { error } = await supabase.from('llm_decisions').insert({
        signal_id: decision.signalId,
        decision: decision.decision,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        delay_minutes: decision.delayMinutes,
        news_context: decision.newsContext,
      });

      if (error) {
        throw error;
      }
    } catch (error) {
      this.handleError('Failed to save LLM decision to Supabase', error);
    }
  }

  /**
   * Save closed trade to Supabase
   */
  private async saveClosedTrade(trade: import('../types/index.js').ClosedTrade): Promise<void> {
    try {
      const { error } = await supabase.from('trades').insert({
        id: trade.id,
        symbol: trade.symbol,
        direction: trade.direction,
        entry_price: trade.entryPrice,
        exit_price: trade.exitPrice,
        quantity: trade.quantity,
        entry_time: new Date(trade.entryTime).toISOString(),
        exit_time: new Date(trade.exitTime).toISOString(),
        pnl: trade.pnl,
        pnl_percent: trade.pnlPercent,
        commission: trade.commission,
        outcome: trade.outcome,
        exit_reason: trade.exitReason,
        signal_id: trade.signalId,
        post_trade_analysis: trade.postTradeAnalysis,
        is_open: false,
      });

      if (error) {
        throw error;
      }
    } catch (error) {
      this.handleError('Failed to save closed trade to Supabase', error);
    }
  }

  /**
   * Save portfolio snapshot to Supabase
   */
  private async savePortfolioSnapshot(): Promise<void> {
    try {
      const state = this.portfolio.getState();

      const { error } = await supabase.from('portfolio_snapshots').insert({
        total_equity: state.totalEquity,
        available_cash: state.availableCash,
        positions: state.positions,
        total_pnl: state.totalPnL,
        total_pnl_percent: state.totalPnLPercent,
        total_trades: state.totalTrades,
        win_rate: state.winRate,
      });

      if (error) {
        throw error;
      }

      logger.info('TradingEngine', 'Portfolio snapshot saved', {
        equity: state.totalEquity.toFixed(2),
        pnl: state.totalPnL.toFixed(2),
      });
    } catch (error) {
      this.handleError('Failed to save portfolio snapshot to Supabase', error);
    }
  }

  /**
   * Handle errors gracefully
   */
  private handleError(message: string, error: unknown): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('TradingEngine', message, error);

    this.errors.push(`${new Date().toISOString()}: ${message} - ${errorMsg}`);

    // Keep only last 100 errors
    if (this.errors.length > 100) {
      this.errors = this.errors.slice(-100);
    }

    // Set error status if too many errors
    if (this.errors.length > 50) {
      this.status = 'error';
      logger.error('TradingEngine', 'Too many errors, setting status to ERROR');
    }
  }
}
