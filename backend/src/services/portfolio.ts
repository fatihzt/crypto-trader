// ============================================
// PORTFOLIO SERVICE
// Virtual Portfolio Manager with Risk-Based Position Sizing
// ============================================

import { randomUUID } from 'crypto';
import type {
  TradingConfig,
  PortfolioState,
  Position,
  ClosedTrade,
  TradeSignal,
  TradeExitReason,
  TradeOutcome,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

export class PortfolioService {
  private config: TradingConfig;
  private totalEquity: number;
  private availableCash: number;
  private positions: Map<string, Position> = new Map();
  private closedTrades: ClosedTrade[] = [];
  private initialCapital: number;

  constructor(config: TradingConfig) {
    this.config = config;
    this.initialCapital = config.initialCapital;
    this.totalEquity = config.initialCapital;
    this.availableCash = config.initialCapital;

    logger.info('Portfolio', 'Portfolio initialized', {
      capital: config.initialCapital,
      maxPositions: config.maxOpenPositions,
      riskPerTrade: config.riskPerTradePercent,
    });
  }

  /**
   * Get current portfolio state
   */
  public getState(): PortfolioState {
    const positionsArray = Array.from(this.positions.values());

    // Calculate total unrealized PnL
    const totalUnrealizedPnL = positionsArray.reduce(
      (sum, pos) => sum + pos.unrealizedPnL,
      0
    );

    // Calculate total realized PnL from closed trades
    const totalRealizedPnL = this.closedTrades.reduce(
      (sum, trade) => sum + trade.pnl,
      0
    );

    const totalPnL = totalRealizedPnL + totalUnrealizedPnL;
    const totalPnLPercent = (totalPnL / this.initialCapital) * 100;

    // Calculate win rate
    const winningTrades = this.closedTrades.filter(t => t.outcome === 'win').length;
    const winRate = this.closedTrades.length > 0
      ? winningTrades / this.closedTrades.length
      : 0;

    return {
      totalEquity: this.totalEquity,
      availableCash: this.availableCash,
      positions: positionsArray,
      totalPnL,
      totalPnLPercent,
      totalTrades: this.closedTrades.length,
      winRate,
      timestamp: Date.now(),
    };
  }

  /**
   * Check if we can open a new position
   */
  public canOpenPosition(symbol: string): boolean {
    // Check max open positions
    if (this.positions.size >= this.config.maxOpenPositions) {
      logger.warn('Portfolio', 'Max positions reached', {
        current: this.positions.size,
        max: this.config.maxOpenPositions,
      });
      return false;
    }

    // Check if we have enough available cash (at least 10% of portfolio)
    const minCash = this.totalEquity * 0.1;
    if (this.availableCash < minCash) {
      logger.warn('Portfolio', 'Insufficient available cash', {
        available: this.availableCash,
        required: minCash,
      });
      return false;
    }

    return true;
  }

  /**
   * Open a new position based on signal
   */
  public openPosition(signal: TradeSignal, currentPrice: number): Position | null {
    if (!this.canOpenPosition(signal.symbol)) {
      return null;
    }

    // Only accept LONG or SHORT signals
    if (signal.direction === 'NEUTRAL') {
      logger.warn('Portfolio', 'Cannot open position with NEUTRAL direction', { symbol: signal.symbol });
      return null;
    }

    // Calculate position size based on risk
    const positionSize = this.calculatePositionSize(
      signal.entryPrice,
      signal.stopLoss,
      signal.direction
    );

    if (positionSize === 0) {
      logger.warn('Portfolio', 'Position size calculated as 0', {
        symbol: signal.symbol,
        entry: signal.entryPrice,
        stop: signal.stopLoss,
      });
      return null;
    }

    // Calculate position value
    const positionValue = positionSize * currentPrice;

    // Deduct commission on entry
    const entryCommission = positionValue * this.config.commissionRate;
    const totalCost = positionValue + entryCommission;

    // Check if we have enough cash
    if (totalCost > this.availableCash) {
      logger.warn('Portfolio', 'Insufficient cash for position', {
        required: totalCost,
        available: this.availableCash,
      });
      return null;
    }

    // Create position
    const position: Position = {
      id: randomUUID(),
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: currentPrice,
      currentPrice,
      quantity: positionSize,
      entryTime: Date.now(),
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      unrealizedPnL: -entryCommission, // Start with negative commission
      unrealizedPnLPercent: (-entryCommission / positionValue) * 100,
      signalId: signal.id,
    };

    // Update portfolio
    this.positions.set(position.id, position);
    this.availableCash -= totalCost;

    logger.trade('OPEN', signal.symbol, {
      id: position.id,
      direction: signal.direction,
      entry: currentPrice,
      quantity: positionSize,
      value: positionValue,
      commission: entryCommission,
      stop: signal.stopLoss,
      target: signal.takeProfit,
    });

    return position;
  }

  /**
   * Close a position
   */
  public closePosition(
    positionId: string,
    exitPrice: number,
    exitReason: TradeExitReason
  ): ClosedTrade | null {
    // Find position
    const position = Array.from(this.positions.values()).find(p => p.id === positionId);
    if (!position) {
      logger.error('Portfolio', 'Position not found', positionId);
      return null;
    }

    // Calculate P&L
    const positionValue = position.quantity * position.entryPrice;
    const exitValue = position.quantity * exitPrice;

    let grossPnL: number;
    if (position.direction === 'LONG') {
      grossPnL = exitValue - positionValue;
    } else {
      // SHORT: profit when price goes down
      grossPnL = positionValue - exitValue;
    }

    // Calculate commissions (entry + exit)
    const entryCommission = positionValue * this.config.commissionRate;
    const exitCommission = exitValue * this.config.commissionRate;
    const totalCommission = entryCommission + exitCommission;

    // Net P&L after commissions
    const netPnL = grossPnL - totalCommission;
    const pnlPercent = (netPnL / positionValue) * 100;

    // Determine outcome
    let outcome: TradeOutcome;
    if (netPnL > 0) {
      outcome = 'win';
    } else if (netPnL < 0) {
      outcome = 'loss';
    } else {
      outcome = 'breakeven';
    }

    // Create closed trade record
    const closedTrade: ClosedTrade = {
      id: position.id,
      symbol: position.symbol,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      entryTime: position.entryTime,
      exitTime: Date.now(),
      pnl: netPnL,
      pnlPercent,
      commission: totalCommission,
      outcome,
      exitReason,
      signalId: position.signalId,
      llmApproval: {
        signalId: position.signalId,
        decision: 'APPROVE', // Placeholder - will be set by LLM service
        confidence: 1,
        reasoning: 'Auto-approved',
        newsContext: [],
        timestamp: position.entryTime,
      },
    };

    // Update portfolio
    this.positions.delete(position.id);
    this.availableCash += exitValue - exitCommission;
    this.totalEquity = this.availableCash + this.getPositionsValue();
    this.closedTrades.push(closedTrade);

    logger.trade('CLOSE', position.symbol, {
      id: position.id,
      direction: position.direction,
      entry: position.entryPrice,
      exit: exitPrice,
      pnl: netPnL,
      pnlPercent: pnlPercent.toFixed(2),
      outcome,
      reason: exitReason,
    });

    return closedTrade;
  }

  /**
   * Update all open positions with current prices
   */
  public updatePositions(prices: Record<string, number>): void {
    for (const position of this.positions.values()) {
      const currentPrice = prices[position.symbol];
      if (!currentPrice) continue;

      position.currentPrice = currentPrice;

      // Calculate unrealized P&L
      const positionValue = position.quantity * position.entryPrice;
      const currentValue = position.quantity * currentPrice;

      let grossPnL: number;
      if (position.direction === 'LONG') {
        grossPnL = currentValue - positionValue;
      } else {
        // SHORT: profit when price goes down
        grossPnL = positionValue - currentValue;
      }

      // Subtract entry commission (exit commission not yet incurred)
      const entryCommission = positionValue * this.config.commissionRate;
      position.unrealizedPnL = grossPnL - entryCommission;
      position.unrealizedPnLPercent = (position.unrealizedPnL / positionValue) * 100;
    }

    // Update total equity
    this.totalEquity = this.availableCash + this.getPositionsValue();
  }

  /**
   * Get all open positions
   */
  public getOpenPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get all closed trades
   */
  public getClosedTrades(): ClosedTrade[] {
    return this.closedTrades;
  }

  /**
   * Calculate position size based on risk
   */
  private calculatePositionSize(
    entryPrice: number,
    stopLoss: number,
    direction: 'LONG' | 'SHORT'
  ): number {
    // Calculate risk per trade in dollars
    const riskAmount = this.totalEquity * this.config.riskPerTradePercent;

    // Calculate stop distance
    const stopDistance = Math.abs(entryPrice - stopLoss);

    if (stopDistance === 0) {
      logger.warn('Portfolio', 'Stop distance is zero, cannot calculate position size', {
        entry: entryPrice,
        stop: stopLoss,
      });
      return 0;
    }

    // Position size based on risk: quantity = risk / stopDistance
    let quantity = riskAmount / stopDistance;

    // Cap at max position percent of portfolio
    const maxPositionValue = this.totalEquity * this.config.maxPositionPercent;
    const maxQuantity = maxPositionValue / entryPrice;

    if (quantity > maxQuantity) {
      logger.warn('Portfolio', 'Position size capped by max position percent', {
        calculated: quantity,
        max: maxQuantity,
      });
      quantity = maxQuantity;
    }

    return quantity;
  }

  /**
   * Calculate total value of all open positions
   */
  private getPositionsValue(): number {
    return Array.from(this.positions.values()).reduce(
      (sum, pos) => sum + (pos.quantity * pos.currentPrice),
      0
    );
  }
}
