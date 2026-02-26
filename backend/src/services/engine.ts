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
import { sql } from '../config/supabase.js';
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

      // Register candle callback BEFORE starting Binance
      // (so we don't miss any candles from polling fallback)
      this.binance.onCandle((candle) => {
        this.onCandleClosed(candle).catch((error) => {
          this.handleError('Candle processing error', error);
        });
      });

      // Start Binance service (won't crash even if initial fetch fails)
      try {
        await this.binance.start();
      } catch (error) {
        logger.warn('TradingEngine', 'Binance start had errors, polling fallback active', error);
      }

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

    // Collect current prices
    const prices: Record<string, number> = {};
    for (const sym of CONFIG.symbols) {
      prices[sym] = this.binance.getCurrentPrice(sym);
    }

    return {
      status: this.status,
      startedAt: this.startedAt,
      uptime,
      symbols: CONFIG.symbols,
      decisionInterval: CONFIG.interval,
      regimes: Object.fromEntries(this.regimes),
      portfolio: this.portfolio.getState(),
      prices,
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
      if (recentCandles.length < 20) {
        logger.warn('TradingEngine', `Not enough candles for ${symbol} (${recentCandles.length}/20), skipping`);
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

            // Save closed trade to database
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

      // Step 7: Evaluate strategy for new signals - try up to 2 signals per candle
      for (let attempt = 0; attempt < 2; attempt++) {
        const signal = this.strategy.evaluate(symbol, recentCandles, indicators, regimeState);

        if (!signal) break;

        this.lastSignal = signal;

        // Notify signal generated
        await this.notify.signalGenerated(signal);

        // Step 8: Get latest news for LLM context
        const newsItems = await this.news.getLatestNews(symbol);

        // Step 9: Send to LLM filter for approval
        const llmDecision = await this.llm.evaluateSignal(signal, newsItems, fearGreed);
        this.lastLLMDecision = llmDecision;

        // Save signal and LLM decision to database
        await this.saveSignal(signal);
        await this.saveLLMDecision(llmDecision);

        // Step 10: Execute trade if LLM approves
        if (llmDecision.decision === 'APPROVE') {
          const position = this.trader.executeTrade(signal, currentPrice);

          if (position) {
            await this.notify.tradeOpened(position, signal, llmDecision);

            logger.info('TradingEngine', `Trade executed: ${signal.direction} ${symbol}`, {
              positionId: position.id,
              price: currentPrice,
              llmConfidence: llmDecision.confidence,
            });
          } else {
            // Portfolio rejected (max positions or insufficient cash) - stop trying
            break;
          }
        } else {
          await this.notify.tradeRejected(signal, llmDecision);

          logger.info('TradingEngine', `Trade rejected by LLM: ${symbol}`, {
            decision: llmDecision.decision,
            reasoning: llmDecision.reasoning,
          });
          break; // Don't try again if LLM rejected
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
   * Save signal to database.
   * indicators and regime are JSONB columns — wrap with sql.json() so postgres.js
   * serialises them correctly instead of attempting to bind as a plain parameter.
   */
  private async saveSignal(signal: TradeSignal): Promise<void> {
    try {
      await sql`
        INSERT INTO signals (
          id, symbol, direction, strength, entry_price, stop_loss,
          take_profit, risk_reward_ratio, reason, indicators, regime
        ) VALUES (
          ${signal.id}, ${signal.symbol}, ${signal.direction}, ${signal.strength},
          ${signal.entryPrice}, ${signal.stopLoss}, ${signal.takeProfit},
          ${signal.riskRewardRatio}, ${signal.reason},
          ${sql.json(signal.indicators as never)}, ${sql.json(signal.regime as never)}
        )
      `;
    } catch (error) {
      this.handleError('Failed to save signal to database', error);
    }
  }

  /**
   * Save LLM decision to database.
   * newsContext is a string array (JSONB column) — wrap with sql.json().
   */
  private async saveLLMDecision(decision: LLMFilterResult): Promise<void> {
    try {
      await sql`
        INSERT INTO llm_decisions (
          signal_id, decision, confidence, reasoning, delay_minutes, news_context
        ) VALUES (
          ${decision.signalId}, ${decision.decision}, ${decision.confidence},
          ${decision.reasoning}, ${decision.delayMinutes ?? null},
          ${sql.json(decision.newsContext as never)}
        )
      `;
    } catch (error) {
      this.handleError('Failed to save LLM decision to database', error);
    }
  }

  /**
   * Save closed trade to database.
   */
  private async saveClosedTrade(trade: import('../types/index.js').ClosedTrade): Promise<void> {
    try {
      await sql`
        INSERT INTO trades (
          id, symbol, direction, entry_price, exit_price, quantity,
          entry_time, exit_time, pnl, pnl_percent, commission, outcome,
          exit_reason, signal_id, post_trade_analysis, is_open
        ) VALUES (
          ${trade.id}, ${trade.symbol}, ${trade.direction}, ${trade.entryPrice},
          ${trade.exitPrice}, ${trade.quantity},
          ${new Date(trade.entryTime).toISOString()}, ${new Date(trade.exitTime).toISOString()},
          ${trade.pnl}, ${trade.pnlPercent}, ${trade.commission}, ${trade.outcome},
          ${trade.exitReason}, ${trade.signalId},
          ${trade.postTradeAnalysis ?? null}, ${false}
        )
      `;
    } catch (error) {
      this.handleError('Failed to save closed trade to database', error);
    }
  }

  /**
   * Save portfolio snapshot to database.
   * positions is a Position[] (JSONB column) — wrap with sql.json().
   */
  private async savePortfolioSnapshot(): Promise<void> {
    try {
      const state = this.portfolio.getState();

      await sql`
        INSERT INTO portfolio_snapshots (
          total_equity, available_cash, positions, total_pnl,
          total_pnl_percent, total_trades, win_rate
        ) VALUES (
          ${state.totalEquity}, ${state.availableCash},
          ${sql.json(state.positions as never)}, ${state.totalPnL},
          ${state.totalPnLPercent}, ${state.totalTrades}, ${state.winRate}
        )
      `;

      logger.info('TradingEngine', 'Portfolio snapshot saved', {
        equity: state.totalEquity.toFixed(2),
        pnl: state.totalPnL.toFixed(2),
      });
    } catch (error) {
      this.handleError('Failed to save portfolio snapshot to database', error);
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
