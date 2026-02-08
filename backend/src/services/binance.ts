import WebSocket from 'ws';
import { Candle } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

interface BinanceKlineData {
  e: string; // Event type
  E: number; // Event time
  s: string; // Symbol
  k: {
    t: number; // Kline start time
    T: number; // Kline close time
    s: string; // Symbol
    i: string; // Interval
    f: number; // First trade ID
    L: number; // Last trade ID
    o: string; // Open price
    c: string; // Close price
    h: string; // High price
    l: string; // Low price
    v: string; // Base asset volume
    n: number; // Number of trades
    x: boolean; // Is this kline closed?
    q: string; // Quote asset volume
    V: string; // Taker buy base asset volume
    Q: string; // Taker buy quote asset volume
    B: string; // Ignore
  };
}

interface BinanceKlineRest {
  0: number; // Open time
  1: string; // Open
  2: string; // High
  3: string; // Low
  4: string; // Close
  5: string; // Volume
  6: number; // Close time
  7: string; // Quote asset volume
  8: number; // Number of trades
  9: string; // Taker buy base asset volume
  10: string; // Taker buy quote asset volume
  11: string; // Ignore
}

export class BinanceService {
  private ws: WebSocket | null = null;
  private candleBuffers: Map<string, Candle[]> = new Map();
  private candleCallbacks: Array<(candle: Candle) => void> = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 1000; // 1 second
  private isRunning = false;
  private readonly symbols = ['BTCUSDT', 'ETHUSDT'];
  private readonly interval = '15m';
  private readonly bufferSize = 200;

  constructor() {
    // Initialize buffers
    this.symbols.forEach(symbol => {
      this.candleBuffers.set(symbol, []);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('BinanceService', 'Service already running');
      return;
    }

    logger.info('BinanceService', 'Starting Binance market data service');
    this.isRunning = true;

    // Fetch historical candles (retry up to 5 times)
    for (const symbol of this.symbols) {
      await this.fetchHistoricalWithRetry(symbol, 5);
    }

    // Connect to WebSocket
    this.connectWebSocket();

    // Start polling fallback in case WebSocket fails
    this.startPollingFallback();
  }

  private async fetchHistoricalWithRetry(symbol: string, maxRetries: number): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.fetchHistoricalCandles(symbol);
        return;
      } catch (error) {
        logger.warn('BinanceService', `Historical fetch attempt ${attempt}/${maxRetries} failed for ${symbol}`, error);
        if (attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    logger.error('BinanceService', `All ${maxRetries} attempts failed for ${symbol}, will rely on polling`);
  }

  /**
   * Polling fallback: fetch latest candles every 60s via REST API
   * This ensures data flows even if WebSocket is blocked
   */
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  private startPollingFallback(): void {
    this.pollingInterval = setInterval(async () => {
      if (!this.isRunning) {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        return;
      }

      for (const symbol of this.symbols) {
        try {
          const url = `${env.BINANCE_REST_URL}/api/v3/klines?symbol=${symbol}&interval=${this.interval}&limit=5`;
          const response = await fetch(url);

          if (!response.ok) {
            logger.warn('BinanceService', `Polling failed for ${symbol}: HTTP ${response.status}`);
            continue;
          }

          const data = await response.json() as BinanceKlineRest[];
          const buffer = this.candleBuffers.get(symbol) || [];

          for (const k of data) {
            const candle: Candle = {
              symbol,
              interval: this.interval,
              openTime: k[0],
              closeTime: k[6],
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
              isClosed: Date.now() > k[6],
            };

            // Only process closed candles that aren't already in buffer
            if (candle.isClosed) {
              const exists = buffer.some(c => c.openTime === candle.openTime);
              if (!exists) {
                buffer.push(candle);
                if (buffer.length > this.bufferSize) {
                  buffer.shift();
                }
                this.candleBuffers.set(symbol, buffer);

                logger.info('BinanceService', `[POLL] New closed candle: ${symbol}`, {
                  time: new Date(candle.closeTime).toISOString(),
                  close: candle.close,
                });

                // Notify callbacks
                this.candleCallbacks.forEach(cb => {
                  try { cb(candle); } catch (e) {
                    logger.error('BinanceService', 'Callback error', e);
                  }
                });
              }
            } else {
              // Update latest non-closed candle for price display
              if (buffer.length > 0 && buffer[buffer.length - 1].openTime === candle.openTime) {
                buffer[buffer.length - 1] = candle;
              } else if (!buffer.some(c => c.openTime === candle.openTime)) {
                buffer.push(candle);
                if (buffer.length > this.bufferSize) buffer.shift();
              }
              this.candleBuffers.set(symbol, buffer);
            }
          }
        } catch (error) {
          logger.warn('BinanceService', `Polling error for ${symbol}`, error);
        }
      }
    }, 60_000); // Poll every 60 seconds
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('BinanceService', 'Stopping Binance market data service');
    this.isRunning = false;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  onCandle(callback: (candle: Candle) => void): void {
    this.candleCallbacks.push(callback);
  }

  getRecentCandles(symbol: string, limit: number): Candle[] {
    const buffer = this.candleBuffers.get(symbol) || [];
    return buffer.slice(-limit);
  }

  getCurrentPrice(symbol: string): number {
    const buffer = this.candleBuffers.get(symbol) || [];
    if (buffer.length === 0) {
      return 0;
    }
    return buffer[buffer.length - 1].close;
  }

  private async fetchHistoricalCandles(symbol: string): Promise<void> {
    try {
      logger.info('BinanceService', `Fetching historical candles for ${symbol}`);

      const url = `${env.BINANCE_REST_URL}/api/v3/klines?symbol=${symbol}&interval=${this.interval}&limit=100`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as BinanceKlineRest[];

      const candles: Candle[] = data.map(k => ({
        symbol,
        interval: this.interval,
        openTime: k[0],
        closeTime: k[6],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        isClosed: true,
      }));

      this.candleBuffers.set(symbol, candles);
      logger.info('BinanceService', `Loaded ${candles.length} historical candles for ${symbol}`, {
        firstCandle: new Date(candles[0].openTime).toISOString(),
        lastCandle: new Date(candles[candles.length - 1].closeTime).toISOString(),
      });
    } catch (error) {
      logger.error('BinanceService', `Failed to fetch historical candles for ${symbol}`, error);
      throw error;
    }
  }

  private connectWebSocket(): void {
    // Build combined stream URL
    const streams = this.symbols.map(s => `${s.toLowerCase()}@kline_${this.interval}`).join('/');
    const wsUrl = `${env.BINANCE_WS_URL}/stream?streams=${streams}`;

    logger.info('BinanceService', 'Connecting to Binance WebSocket', { url: wsUrl });

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      logger.info('BinanceService', 'WebSocket connected');
      this.reconnectAttempts = 0; // Reset on successful connection
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString()) as { stream: string; data: BinanceKlineData };

        if (message.data && message.data.e === 'kline') {
          this.handleKlineMessage(message.data);
        }
      } catch (error) {
        logger.error('BinanceService', 'Failed to parse WebSocket message', error);
      }
    });

    this.ws.on('error', (error) => {
      logger.error('BinanceService', 'WebSocket error', error);
    });

    this.ws.on('close', () => {
      logger.warn('BinanceService', 'WebSocket disconnected');

      if (this.isRunning) {
        this.scheduleReconnect();
      }
    });
  }

  private handleKlineMessage(data: BinanceKlineData): void {
    const candle: Candle = {
      symbol: data.k.s,
      interval: data.k.i,
      openTime: data.k.t,
      closeTime: data.k.T,
      open: parseFloat(data.k.o),
      high: parseFloat(data.k.h),
      low: parseFloat(data.k.l),
      close: parseFloat(data.k.c),
      volume: parseFloat(data.k.v),
      isClosed: data.k.x,
    };

    // Update buffer
    const buffer = this.candleBuffers.get(candle.symbol) || [];

    if (candle.isClosed) {
      // Check if this candle is already in buffer (avoid duplicates)
      const existingIndex = buffer.findIndex(c => c.openTime === candle.openTime);

      if (existingIndex === -1) {
        // New closed candle - add to buffer
        buffer.push(candle);

        // Maintain buffer size
        if (buffer.length > this.bufferSize) {
          buffer.shift();
        }

        this.candleBuffers.set(candle.symbol, buffer);

        logger.info('BinanceService', `New closed candle: ${candle.symbol}`, {
          time: new Date(candle.closeTime).toISOString(),
          close: candle.close,
          volume: candle.volume,
        });

        // Notify callbacks
        this.candleCallbacks.forEach(callback => {
          try {
            callback(candle);
          } catch (error) {
            logger.error('BinanceService', 'Error in candle callback', error);
          }
        });
      }
    } else {
      // Update the last candle in buffer if it's the same open time
      if (buffer.length > 0 && buffer[buffer.length - 1].openTime === candle.openTime) {
        buffer[buffer.length - 1] = candle;
      } else {
        // This is a new candle that's not closed yet
        buffer.push(candle);
        if (buffer.length > this.bufferSize) {
          buffer.shift();
        }
      }
      this.candleBuffers.set(candle.symbol, buffer);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('BinanceService', 'Max reconnect attempts reached. Service stopped.');
      this.isRunning = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      30000 // Max 30 seconds
    );

    logger.info('BinanceService', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      if (this.isRunning) {
        this.connectWebSocket();
      }
    }, delay);
  }
}
