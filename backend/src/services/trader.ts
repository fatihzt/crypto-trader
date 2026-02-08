// ============================================
// TRADER SERVICE
// Trade Execution & Position Management with Trailing Stops
// ============================================

import type {
  TradingConfig,
  Position,
  ClosedTrade,
  TradeSignal,
} from '../types/index.js';
import { PortfolioService } from './portfolio.js';
import { logger } from '../utils/logger.js';

interface TrailingStopState {
  isActive: boolean;
  activationPrice: number;
  highestPrice: number;  // For LONG positions
  lowestPrice: number;   // For SHORT positions
  currentStop: number;
}

export class TraderService {
  private portfolio: PortfolioService;
  private config: TradingConfig;
  private trailingStops: Map<string, TrailingStopState> = new Map();

  constructor(portfolio: PortfolioService, config: TradingConfig) {
    this.portfolio = portfolio;
    this.config = config;

    logger.info('Trader', 'Trade execution manager initialized', {
      trailingActivation: config.trailingStopActivation,
      trailingDistance: config.trailingStopDistance,
    });
  }

  /**
   * Execute a new trade based on signal
   */
  public executeTrade(signal: TradeSignal, currentPrice: number): Position | null {
    // Attempt to open position
    const position = this.portfolio.openPosition(signal, currentPrice);

    if (position) {
      // Initialize trailing stop state for this position
      this.trailingStops.set(position.id, {
        isActive: false,
        activationPrice: 0,
        highestPrice: currentPrice,
        lowestPrice: currentPrice,
        currentStop: position.stopLoss,
      });

      logger.info('Trader', `Trade executed: ${signal.direction} ${signal.symbol}`, {
        positionId: position.id,
        price: currentPrice,
        quantity: position.quantity,
      });
    }

    return position;
  }

  /**
   * Check all open positions for exit conditions
   * Returns array of closed trades
   */
  public checkExits(prices: Record<string, number>): ClosedTrade[] {
    const closedTrades: ClosedTrade[] = [];
    const openPositions = this.portfolio.getOpenPositions();

    for (const position of openPositions) {
      const currentPrice = prices[position.symbol];
      if (!currentPrice) continue;

      // Update trailing stop
      this.updateTrailingStop(position, currentPrice);

      // Get trailing stop state
      const trailingState = this.trailingStops.get(position.id);
      if (!trailingState) continue;

      // Check exit conditions
      const exitReason = this.checkExitConditions(position, currentPrice, trailingState);

      if (exitReason) {
        const closedTrade = this.portfolio.closePosition(
          position.id,
          currentPrice,
          exitReason
        );

        if (closedTrade) {
          closedTrades.push(closedTrade);
          this.trailingStops.delete(position.id);
        }
      }
    }

    // Update position prices
    this.portfolio.updatePositions(prices);

    return closedTrades;
  }

  /**
   * Update trailing stop for a position
   */
  private updateTrailingStop(position: Position, currentPrice: number): void {
    const trailingState = this.trailingStops.get(position.id);
    if (!trailingState) return;

    // Calculate current unrealized profit percent
    const positionValue = position.quantity * position.entryPrice;
    let grossPnL: number;

    if (position.direction === 'LONG') {
      const currentValue = position.quantity * currentPrice;
      grossPnL = currentValue - positionValue;
    } else {
      // SHORT
      const currentValue = position.quantity * currentPrice;
      grossPnL = positionValue - currentValue;
    }

    const profitPercent = grossPnL / positionValue;

    // Check if trailing stop should be activated
    if (!trailingState.isActive && profitPercent > this.config.trailingStopActivation) {
      trailingState.isActive = true;
      trailingState.activationPrice = currentPrice;

      logger.info('Trader', `Trailing stop activated for ${position.symbol}`, {
        positionId: position.id,
        activationPrice: currentPrice,
        profitPercent: (profitPercent * 100).toFixed(2),
      });
    }

    // Update trailing stop if active
    if (trailingState.isActive) {
      if (position.direction === 'LONG') {
        // Update highest price seen
        if (currentPrice > trailingState.highestPrice) {
          trailingState.highestPrice = currentPrice;

          // Calculate new trailing stop
          const newStop = trailingState.highestPrice * (1 - this.config.trailingStopDistance);

          // Only move stop up, never down
          if (newStop > trailingState.currentStop) {
            trailingState.currentStop = newStop;

            logger.info('Trader', `Trailing stop updated for ${position.symbol}`, {
              positionId: position.id,
              newStop: newStop.toFixed(2),
              highestPrice: trailingState.highestPrice.toFixed(2),
            });
          }
        }
      } else {
        // SHORT position
        // Update lowest price seen
        if (currentPrice < trailingState.lowestPrice) {
          trailingState.lowestPrice = currentPrice;

          // Calculate new trailing stop
          const newStop = trailingState.lowestPrice * (1 + this.config.trailingStopDistance);

          // Only move stop down, never up
          if (newStop < trailingState.currentStop) {
            trailingState.currentStop = newStop;

            logger.info('Trader', `Trailing stop updated for ${position.symbol}`, {
              positionId: position.id,
              newStop: newStop.toFixed(2),
              lowestPrice: trailingState.lowestPrice.toFixed(2),
            });
          }
        }
      }
    }
  }

  /**
   * Check if position should be exited
   * Returns exit reason or null
   */
  private checkExitConditions(
    position: Position,
    currentPrice: number,
    trailingState: TrailingStopState
  ): 'take_profit' | 'stop_loss' | 'trailing_stop' | null {
    if (position.direction === 'LONG') {
      // Check take-profit
      if (currentPrice >= position.takeProfit) {
        logger.info('Trader', `Take-profit hit for ${position.symbol}`, {
          positionId: position.id,
          target: position.takeProfit,
          price: currentPrice,
        });
        return 'take_profit';
      }

      // Check trailing stop (if active)
      if (trailingState.isActive && currentPrice <= trailingState.currentStop) {
        logger.info('Trader', `Trailing stop hit for ${position.symbol}`, {
          positionId: position.id,
          stop: trailingState.currentStop,
          price: currentPrice,
        });
        return 'trailing_stop';
      }

      // Check original stop-loss
      if (currentPrice <= position.stopLoss) {
        logger.info('Trader', `Stop-loss hit for ${position.symbol}`, {
          positionId: position.id,
          stop: position.stopLoss,
          price: currentPrice,
        });
        return 'stop_loss';
      }
    } else {
      // SHORT position
      // Check take-profit
      if (currentPrice <= position.takeProfit) {
        logger.info('Trader', `Take-profit hit for ${position.symbol}`, {
          positionId: position.id,
          target: position.takeProfit,
          price: currentPrice,
        });
        return 'take_profit';
      }

      // Check trailing stop (if active)
      if (trailingState.isActive && currentPrice >= trailingState.currentStop) {
        logger.info('Trader', `Trailing stop hit for ${position.symbol}`, {
          positionId: position.id,
          stop: trailingState.currentStop,
          price: currentPrice,
        });
        return 'trailing_stop';
      }

      // Check original stop-loss
      if (currentPrice >= position.stopLoss) {
        logger.info('Trader', `Stop-loss hit for ${position.symbol}`, {
          positionId: position.id,
          stop: position.stopLoss,
          price: currentPrice,
        });
        return 'stop_loss';
      }
    }

    return null;
  }

  /**
   * Get current trailing stop state for a position
   */
  public getTrailingStopState(positionId: string): TrailingStopState | undefined {
    return this.trailingStops.get(positionId);
  }

  /**
   * Get all trailing stop states
   */
  public getAllTrailingStopStates(): Map<string, TrailingStopState> {
    return new Map(this.trailingStops);
  }
}
