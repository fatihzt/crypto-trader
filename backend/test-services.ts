#!/usr/bin/env tsx
// ============================================
// Test script for Binance, Indicators, and Regime services
// Run with: npx tsx test-services.ts
// ============================================

import { BinanceService } from './src/services/binance.js';
import { IndicatorService } from './src/services/indicators.js';
import { RegimeService } from './src/services/regime.js';
import { logger } from './src/utils/logger.js';

async function main() {
  logger.info('Test', 'Starting services test...');

  // Initialize services
  const binanceService = new BinanceService();
  const indicatorService = new IndicatorService();
  const regimeService = new RegimeService();

  // Set up candle callback to demonstrate full pipeline
  binanceService.onCandle((candle) => {
    logger.info('Test', `Received closed candle: ${candle.symbol} @ ${candle.close}`);

    // Get recent candles for indicator calculation
    const recentCandles = binanceService.getRecentCandles(candle.symbol, 100);

    if (recentCandles.length >= 50) {
      // Calculate indicators
      const indicators = indicatorService.calculate(candle.symbol, recentCandles);

      logger.info('Test', `Indicators calculated for ${candle.symbol}`, {
        ema9: indicators.ema9.toFixed(2),
        ema21: indicators.ema21.toFixed(2),
        ema50: indicators.ema50.toFixed(2),
        rsi14: indicators.rsi14.toFixed(2),
        atr14: indicators.atr14.toFixed(2),
        atrPercent: indicators.atrPercent.toFixed(2),
        adx14: indicators.adx14.toFixed(2),
      });

      // Evaluate regime (using mock fear & greed index)
      const mockFearGreedIndex = 50; // Neutral
      const regime = regimeService.evaluate(candle.symbol, indicators, mockFearGreedIndex);

      logger.regime(regime.symbol, regime.decision, {
        volatility: regime.volatility,
        trend: regime.trend,
        fearGreed: regime.fearGreedLabel,
        reason: regime.reason,
      });
    } else {
      logger.info('Test', `Not enough candles yet for ${candle.symbol}: ${recentCandles.length}/50`);
    }
  });

  try {
    // Start Binance service
    await binanceService.start();

    logger.info('Test', 'Services started successfully!');
    logger.info('Test', 'Waiting for candles... (this may take up to 15 minutes for first closed candle)');

    // Check current prices every 30 seconds
    const priceCheckInterval = setInterval(() => {
      const btcPrice = binanceService.getCurrentPrice('BTCUSDT');
      const ethPrice = binanceService.getCurrentPrice('ETHUSDT');

      if (btcPrice > 0 && ethPrice > 0) {
        logger.info('Test', 'Current prices', {
          BTC: btcPrice.toFixed(2),
          ETH: ethPrice.toFixed(2),
        });

        // Get recent candles count
        const btcCandles = binanceService.getRecentCandles('BTCUSDT', 200);
        const ethCandles = binanceService.getRecentCandles('ETHUSDT', 200);

        logger.info('Test', 'Candle buffers', {
          BTCUSDT: btcCandles.length,
          ETHUSDT: ethCandles.length,
        });
      }
    }, 30000);

    // Keep the script running
    process.on('SIGINT', async () => {
      logger.info('Test', 'Shutting down...');
      clearInterval(priceCheckInterval);
      await binanceService.stop();
      process.exit(0);
    });
  } catch (error) {
    logger.error('Test', 'Failed to start services', error);
    process.exit(1);
  }
}

main();
