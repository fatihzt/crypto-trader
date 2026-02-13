// ============================================
// CRYPTO TRADER - Shared Type Definitions
// All services MUST use these types.
// ============================================

// --- Market Data ---

export interface Candle {
  symbol: string;        // "BTCUSDT" | "ETHUSDT"
  interval: string;      // "15m"
  openTime: number;      // Unix ms
  closeTime: number;     // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;     // True when candle is finalized
}

export interface Ticker {
  symbol: string;
  price: number;
  timestamp: number;
}

// --- Technical Indicators ---

export interface Indicators {
  symbol: string;
  timestamp: number;

  // Trend
  ema9: number;
  ema21: number;
  ema50: number;

  // Momentum
  rsi14: number;

  // Volatility
  atr14: number;
  atrPercent: number;     // ATR as % of price

  // Trend Strength
  adx14: number;

  // Volume
  volumeSma20: number;
  volumeRatio: number;    // current vol / sma20

  // Structure (swing points)
  lastSwingHigh: number;
  lastSwingLow: number;
}

// --- Market Regime ---

export type VolatilityRegime = 'low' | 'normal' | 'high' | 'extreme';
export type TrendRegime = 'strong_up' | 'up' | 'neutral' | 'down' | 'strong_down';
export type MarketDecision = 'TRADE_ALLOWED' | 'WAIT' | 'DANGER';

export interface RegimeState {
  symbol: string;
  timestamp: number;
  volatility: VolatilityRegime;
  trend: TrendRegime;
  decision: MarketDecision;
  fearGreedIndex: number;      // 0-100
  fearGreedLabel: string;      // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  reason: string;              // Human-readable explanation
}

// --- Trading Signals ---

export type SignalDirection = 'LONG' | 'SHORT' | 'NEUTRAL';
export type SignalStrength = 'weak' | 'moderate' | 'strong';

export interface TradeSignal {
  id: string;                  // UUID
  symbol: string;
  timestamp: number;
  direction: SignalDirection;
  strength: SignalStrength;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  reason: string;              // Why the signal was generated
  indicators: Indicators;       // Snapshot at signal time
  regime: RegimeState;          // Regime at signal time
}

// --- LLM Filter ---

export type LLMDecision = 'APPROVE' | 'REJECT' | 'DELAY';

export interface LLMFilterResult {
  signalId: string;
  decision: LLMDecision;
  confidence: number;          // 0-1
  reasoning: string;           // LLM explanation
  delayMinutes?: number;       // If DELAY, how long
  newsContext: string[];        // Headlines used in decision
  timestamp: number;
}

// --- Portfolio ---

export interface PortfolioState {
  totalEquity: number;         // Total value in USDT
  availableCash: number;       // Free USDT
  positions: Position[];
  totalPnL: number;            // Absolute PnL
  totalPnLPercent: number;     // PnL as %
  totalTrades: number;
  winRate: number;             // 0-1
  timestamp: number;
}

export interface Position {
  id: string;                  // UUID
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  quantity: number;            // In base asset (BTC/ETH)
  entryTime: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  signalId: string;            // Reference to the signal that opened this
}

// --- Trades (Closed) ---

export type TradeOutcome = 'win' | 'loss' | 'breakeven';
export type TradeExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'structure_break' | 'manual' | 'regime_change';

export interface ClosedTrade {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPercent: number;
  commission: number;          // Total commission paid
  outcome: TradeOutcome;
  exitReason: TradeExitReason;
  signalId: string;
  llmApproval: LLMFilterResult;
  postTradeAnalysis?: string;  // LLM post-trade report
}

// --- News ---

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: 'positive' | 'negative' | 'neutral';
}

// --- Engine State ---

export type EngineStatus = 'starting' | 'running' | 'paused' | 'error';

export interface EngineState {
  status: EngineStatus;
  startedAt: number;
  uptime: number;
  symbols: string[];
  decisionInterval: string;    // "15m"
  regimes: Record<string, RegimeState>;
  portfolio: PortfolioState;
  prices: Record<string, number>;
  lastSignal: TradeSignal | null;
  lastLLMDecision: LLMFilterResult | null;
  errors: string[];
}

// --- Configuration ---

export interface TradingConfig {
  symbols: string[];                  // ["BTCUSDT", "ETHUSDT"]
  interval: string;                   // "15m"
  initialCapital: number;             // 10000
  maxPositionPercent: number;          // Max % of portfolio per trade (e.g. 0.2 = 20%)
  maxOpenPositions: number;            // Max concurrent positions
  commissionRate: number;              // 0.001 = 0.1%
  cooldownCandles: number;             // Min candles between trades on same symbol
  riskPerTradePercent: number;         // Max risk per trade as % of portfolio
  trailingStopActivation: number;      // % profit to activate trailing stop
  trailingStopDistance: number;        // Trailing stop distance as %
}

export const DEFAULT_CONFIG: TradingConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'AVAXUSDT', 'ADAUSDT', 'LINKUSDT', 'MATICUSDT'],
  interval: '5m',
  initialCapital: 10000,
  maxPositionPercent: 0.15,
  maxOpenPositions: 12,
  commissionRate: 0.001,
  cooldownCandles: 0,
  riskPerTradePercent: 0.02,
  trailingStopActivation: 0.008,
  trailingStopDistance: 0.005,
};
