# Backend Services Documentation

## Overview

This document describes the three core services for the crypto trading bot backend:

1. **BinanceService** - Real-time and historical market data from Binance
2. **IndicatorService** - Technical indicator calculations
3. **RegimeService** - Market regime detection and trading decisions

---

## 1. BinanceService

**Location**: `/Users/fatihozata/crypto-trader/backend/src/services/binance.ts`

### Purpose

Connects to Binance WebSocket API for real-time 15-minute candle data and fetches historical candles via REST API to bootstrap technical indicators.

### Features

- Real-time WebSocket streaming for BTCUSDT and ETHUSDT
- REST API for fetching 100 historical candles per symbol
- In-memory circular buffer (200 candles per symbol)
- Auto-reconnect with exponential backoff
- Callback system for closed candles

### API

```typescript
class BinanceService {
  // Start the service (fetch history + connect WebSocket)
  async start(): Promise<void>

  // Stop the service (close WebSocket)
  async stop(): Promise<void>

  // Register callback for closed candles
  onCandle(callback: (candle: Candle) => void): void

  // Get recent candles from buffer
  getRecentCandles(symbol: string, limit: number): Candle[]

  // Get latest price
  getCurrentPrice(symbol: string): number
}
```

### Usage Example

```typescript
import { BinanceService } from './services/binance.js';

const binance = new BinanceService();

// Set up callback for closed candles
binance.onCandle((candle) => {
  console.log(`New candle: ${candle.symbol} @ ${candle.close}`);
});

// Start service
await binance.start();

// Get recent data
const recentCandles = binance.getRecentCandles('BTCUSDT', 50);
const currentPrice = binance.getCurrentPrice('BTCUSDT');
```

### WebSocket Details

- **URL**: `wss://stream.binance.com:9443/ws`
- **Streams**: `btcusdt@kline_15m` and `ethusdt@kline_15m`
- **Reconnect**: Exponential backoff (1s → 2s → 4s → ... max 30s)
- **Max Attempts**: 10 reconnection attempts

### REST API Details

- **URL**: `https://api.binance.com/api/v3/klines`
- **Parameters**:
  - `symbol`: BTCUSDT | ETHUSDT
  - `interval`: 15m
  - `limit`: 100
- **Called**: Once per symbol on `start()`

---

## 2. IndicatorService

**Location**: `/Users/fatihozata/crypto-trader/backend/src/services/indicators.ts`

### Purpose

Calculates all technical indicators from raw candle data. All calculations are implemented from scratch (no external TA libraries).

### Indicators Calculated

| Indicator | Period | Description |
|-----------|--------|-------------|
| EMA 9 | 9 | Fast exponential moving average |
| EMA 21 | 21 | Medium exponential moving average |
| EMA 50 | 50 | Slow exponential moving average |
| RSI 14 | 14 | Relative Strength Index (Wilder's smoothing) |
| ATR 14 | 14 | Average True Range (absolute) |
| ATR % | 14 | ATR as percentage of current price |
| ADX 14 | 14 | Average Directional Index (trend strength) |
| Volume SMA 20 | 20 | Simple moving average of volume |
| Volume Ratio | 20 | Current volume / Volume SMA 20 |
| Last Swing High | 5 | Last pivot high (5-candle lookback) |
| Last Swing Low | 5 | Last pivot low (5-candle lookback) |

### API

```typescript
class IndicatorService {
  // Calculate all indicators from candle array
  calculate(symbol: string, candles: Candle[]): Indicators
}
```

### Usage Example

```typescript
import { IndicatorService } from './services/indicators.js';

const indicatorService = new IndicatorService();

const indicators = indicatorService.calculate('BTCUSDT', candles);

console.log({
  ema9: indicators.ema9,
  rsi14: indicators.rsi14,
  atrPercent: indicators.atrPercent,
  adx14: indicators.adx14,
});
```

### Algorithm Details

#### EMA (Exponential Moving Average)
```
multiplier = 2 / (period + 1)
EMA[0] = SMA(period)
EMA[i] = (price[i] - EMA[i-1]) * multiplier + EMA[i-1]
```

#### RSI (Relative Strength Index - Wilder's Smoothing)
```
avgGain[0] = SMA(gains, period)
avgLoss[0] = SMA(losses, period)
avgGain[i] = (avgGain[i-1] * (period - 1) + gain[i]) / period
avgLoss[i] = (avgLoss[i-1] * (period - 1) + loss[i]) / period
RS = avgGain / avgLoss
RSI = 100 - (100 / (1 + RS))
```

#### ATR (Average True Range)
```
TR = max(high - low, |high - prevClose|, |low - prevClose|)
ATR[0] = SMA(TR, period)
ATR[i] = (ATR[i-1] * (period - 1) + TR[i]) / period
ATR% = (ATR / currentPrice) * 100
```

#### ADX (Average Directional Index)
```
+DM = (high[i] > high[i-1] && highDiff > lowDiff) ? highDiff : 0
-DM = (low[i-1] > low[i] && lowDiff > highDiff) ? lowDiff : 0
Smooth +DM, -DM, TR using Wilder's smoothing
+DI = (smooth+DM / smoothTR) * 100
-DI = (smooth-DM / smoothTR) * 100
DX = (|+DI - -DI| / (+DI + -DI)) * 100
ADX = smoothed DX
```

#### Swing Points
- **Swing High**: High with lower highs on both sides (5-candle lookback)
- **Swing Low**: Low with higher lows on both sides (5-candle lookback)

### Edge Cases

- **Insufficient data**: Returns sensible defaults (EMA = 0, RSI = 50, etc.)
- **Zero division**: Protected (volume ratio = 1 if SMA = 0)
- **Array bounds**: All algorithms check minimum data requirements

---

## 3. RegimeService

**Location**: `/Users/fatihozata/crypto-trader/backend/src/services/regime.ts`

### Purpose

Evaluates market conditions and determines if trading should be allowed. Combines volatility, trend, and fear/greed sentiment to make decisions.

### Classification System

#### Volatility Regime (based on ATR%)

| ATR % | Classification |
|-------|---------------|
| < 0.8 | Low |
| 0.8 - 2.0 | Normal |
| 2.0 - 4.0 | High |
| > 4.0 | Extreme |

#### Trend Regime (based on EMA alignment + ADX)

| Condition | Classification |
|-----------|---------------|
| price > ema9 > ema21 > ema50 AND adx > 25 | Strong Up |
| price > ema21 AND ema9 > ema21 | Up |
| ema9 ≈ ema21 (within 0.3%) OR adx < 15 | Neutral |
| price < ema21 AND ema9 < ema21 | Down |
| price < ema9 < ema21 < ema50 AND adx > 25 | Strong Down |

#### Market Decision Logic

| Condition | Decision |
|-----------|----------|
| volatility = extreme | DANGER |
| fearGreed < 10 AND volatility = high | DANGER |
| volatility = low AND trend = neutral | WAIT |
| All other cases | TRADE_ALLOWED |

### API

```typescript
class RegimeService {
  // Evaluate market regime and return trading decision
  evaluate(
    symbol: string,
    indicators: Indicators,
    fearGreedIndex: number
  ): RegimeState
}
```

### Usage Example

```typescript
import { RegimeService } from './services/regime.js';

const regimeService = new RegimeService();

const regime = regimeService.evaluate('BTCUSDT', indicators, 50);

console.log({
  decision: regime.decision,        // "TRADE_ALLOWED" | "WAIT" | "DANGER"
  volatility: regime.volatility,    // "low" | "normal" | "high" | "extreme"
  trend: regime.trend,              // "strong_up" | "up" | "neutral" | "down" | "strong_down"
  fearGreedLabel: regime.fearGreedLabel, // "Extreme Fear" ... "Extreme Greed"
  reason: regime.reason,            // Human-readable explanation
});
```

### Fear & Greed Index

| Value | Label |
|-------|-------|
| 0-20 | Extreme Fear |
| 21-40 | Fear |
| 41-60 | Neutral |
| 61-80 | Greed |
| 81-100 | Extreme Greed |

---

## Integration Example

Complete pipeline from WebSocket to regime decision:

```typescript
import { BinanceService } from './services/binance.js';
import { IndicatorService } from './services/indicators.js';
import { RegimeService } from './services/regime.js';

// Initialize services
const binance = new BinanceService();
const indicators = new IndicatorService();
const regime = new RegimeService();

// Set up pipeline
binance.onCandle((candle) => {
  // Get recent candles
  const recentCandles = binance.getRecentCandles(candle.symbol, 100);

  if (recentCandles.length >= 50) {
    // Calculate indicators
    const ind = indicators.calculate(candle.symbol, recentCandles);

    // Evaluate regime (assume fearGreed = 50 for example)
    const reg = regime.evaluate(candle.symbol, ind, 50);

    // Make trading decision
    if (reg.decision === 'TRADE_ALLOWED') {
      console.log(`✅ Trading allowed for ${candle.symbol}`);
      // Generate signal...
    } else if (reg.decision === 'WAIT') {
      console.log(`⏸️ Waiting for better conditions: ${reg.reason}`);
    } else {
      console.log(`⛔ DANGER - Do not trade: ${reg.reason}`);
    }
  }
});

// Start service
await binance.start();
```

---

## Testing

A test script is provided to verify all services work together:

```bash
npx tsx test-services.ts
```

This script will:
1. Connect to Binance WebSocket
2. Fetch historical candles
3. Calculate indicators on each closed candle
4. Evaluate regime
5. Log results to console

---

## Type Safety

All services use strict TypeScript types from `/Users/fatihozata/crypto-trader/backend/src/types/index.ts`:

- `Candle` - Market data structure
- `Indicators` - Technical indicator values
- `RegimeState` - Market regime classification
- `VolatilityRegime` - "low" | "normal" | "high" | "extreme"
- `TrendRegime` - "strong_up" | "up" | "neutral" | "down" | "strong_down"
- `MarketDecision` - "TRADE_ALLOWED" | "WAIT" | "DANGER"

---

## Logging

All services use the centralized logger from `/Users/fatihozata/crypto-trader/backend/src/utils/logger.ts`:

```typescript
logger.info('BinanceService', 'Message', { data });
logger.warn('IndicatorService', 'Warning', { data });
logger.error('RegimeService', 'Error', error);
logger.regime('BTCUSDT', 'TRADE_ALLOWED', { details });
```

---

## Configuration

Environment variables (from `/Users/fatihozata/crypto-trader/backend/src/config/env.ts`):

- `BINANCE_WS_URL` - WebSocket URL (default: wss://stream.binance.com:9443/ws)
- `BINANCE_REST_URL` - REST API URL (default: https://api.binance.com)

---

## Performance Considerations

### Memory Usage
- Each symbol maintains 200 candles in memory (~100KB per symbol)
- Total memory for 2 symbols: ~200KB

### CPU Usage
- Indicator calculations run only on closed candles (every 15 minutes)
- All calculations are O(n) where n = number of candles (typically 100)
- Expected CPU time per calculation: < 10ms

### Network Usage
- WebSocket: ~100 bytes per candle update (~6KB/hour per symbol)
- REST API: ~30KB per symbol (one-time on startup)

---

## Error Handling

### BinanceService
- WebSocket disconnects: Auto-reconnect with exponential backoff
- REST API failures: Throws error (service won't start)
- Invalid messages: Logged and skipped

### IndicatorService
- Insufficient data: Returns sensible defaults
- Invalid candle data: Protected by type system

### RegimeService
- Invalid indicators: Will use default values
- No specific error cases (pure calculation)

---

## Future Enhancements

1. **BinanceService**
   - Add support for more symbols dynamically
   - Persist candle history to database
   - Add REST API fallback for WebSocket

2. **IndicatorService**
   - Add Bollinger Bands
   - Add MACD
   - Add Volume Profile

3. **RegimeService**
   - Add machine learning regime classification
   - Add multi-timeframe regime analysis
   - Add regime transition detection

---

## Dependencies

```json
{
  "ws": "^8.18.0",           // WebSocket client
  "dotenv": "^16.4.7",       // Environment variables
  "@types/ws": "^8.5.14"     // TypeScript types for ws
}
```

All other dependencies are standard Node.js built-ins.
