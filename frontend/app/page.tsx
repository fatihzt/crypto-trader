'use client';

import { useEffect, useState } from 'react';
import { fetchAPI } from '@/lib/api';

// Type definitions matching backend
type VolatilityRegime = 'low' | 'normal' | 'high' | 'extreme';
type TrendRegime = 'strong_up' | 'up' | 'neutral' | 'down' | 'strong_down';
type MarketDecision = 'TRADE_ALLOWED' | 'WAIT' | 'DANGER';
type SignalDirection = 'LONG' | 'SHORT' | 'NEUTRAL';
type LLMDecision = 'APPROVE' | 'REJECT' | 'DELAY';
type TradeOutcome = 'win' | 'loss' | 'breakeven';
type TradeExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'structure_break' | 'manual' | 'regime_change';
type EngineStatus = 'starting' | 'running' | 'paused' | 'error';

interface RegimeState {
  symbol: string;
  timestamp: number;
  volatility: VolatilityRegime;
  trend: TrendRegime;
  decision: MarketDecision;
  fearGreedIndex: number;
  fearGreedLabel: string;
  reason: string;
}

interface Position {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  entryTime: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  signalId: string;
}

interface PortfolioState {
  totalEquity: number;
  availableCash: number;
  positions: Position[];
  totalPnL: number;
  totalPnLPercent: number;
  totalTrades: number;
  winRate: number;
  timestamp: number;
}

interface ClosedTrade {
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
  commission: number;
  outcome: TradeOutcome;
  exitReason: TradeExitReason;
  signalId: string;
}

interface LLMFilterResult {
  signalId: string;
  decision: LLMDecision;
  confidence: number;
  reasoning: string;
  delayMinutes?: number;
  newsContext: string[];
  timestamp: number;
}

interface TradeSignal {
  id: string;
  symbol: string;
  timestamp: number;
  direction: SignalDirection;
  strength: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  reason: string;
}

interface EngineState {
  status: EngineStatus;
  startedAt: number;
  uptime: number;
  symbols: string[];
  decisionInterval: string;
  regimes: Record<string, RegimeState>;
  portfolio: PortfolioState;
  prices: Record<string, number>;
  lastSignal: TradeSignal | null;
  lastLLMDecision: LLMFilterResult | null;
  errors: string[];
}

interface Ticker {
  symbol: string;
  price: number;
  timestamp: number;
}

interface DashboardData {
  engineState: EngineState;
  openPositions: Position[];
  closedTrades: ClosedTrade[];
  llmDecisions: LLMFilterResult[];
  prices: Record<string, number>;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchDashboardData = async () => {
    try {
      setError(null);

      const [engineState, openPositions, closedTrades, llmDecisions] = await Promise.all([
        fetchAPI<EngineState>('/api/state'),
        fetchAPI<Position[]>('/api/trades/open'),
        fetchAPI<ClosedTrade[]>('/api/trades'),
        fetchAPI<LLMFilterResult[]>('/api/decisions'),
      ]);

      // Get prices from engine state
      const prices: Record<string, number> = engineState.prices || {};

      setData({
        engineState,
        openPositions,
        closedTrades,
        llmDecisions,
        prices,
      });
      setLastUpdated(new Date());
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 10000); // Refresh every 10 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl text-[var(--text-secondary)]">Connecting...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl text-[var(--red)]">Error loading data: {error}</div>
      </div>
    );
  }

  if (!data) return null;

  const { engineState, openPositions, closedTrades, llmDecisions, prices } = data;
  const { portfolio, regimes, status, uptime } = engineState;

  // Format helpers
  const formatPrice = (price: number) => price.toFixed(2);
  const formatSmall = (val: number) => val.toFixed(4);
  const formatPercent = (val: number) => `${(val * 100).toFixed(2)}%`;
  const formatPnL = (pnl: number) => {
    const color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    const sign = pnl >= 0 ? '+' : '';
    return <span style={{ color }}>{sign}{formatPrice(pnl)}</span>;
  };
  const formatPnLPercent = (pnl: number) => {
    const color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    const sign = pnl >= 0 ? '+' : '';
    return <span style={{ color }}>{sign}{formatPercent(pnl)}</span>;
  };
  const formatUptime = (ms: number) => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  };
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };
  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };
  const formatDuration = (start: number, end: number) => {
    const ms = end - start;
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const getVolatilityColor = (vol: VolatilityRegime) => {
    switch (vol) {
      case 'low': return 'var(--green)';
      case 'normal': return 'var(--blue)';
      case 'high': return 'var(--yellow)';
      case 'extreme': return 'var(--red)';
    }
  };

  const getDecisionStatusClass = (decision: MarketDecision) => {
    switch (decision) {
      case 'TRADE_ALLOWED': return 'status-running';
      case 'WAIT': return 'status-waiting';
      case 'DANGER': return 'status-danger';
    }
  };

  const getTrendSymbol = (trend: TrendRegime) => {
    if (trend.includes('up')) return '↑';
    if (trend.includes('down')) return '↓';
    return '→';
  };

  return (
    <div className="min-h-screen p-6" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-wider">CRYPTO TRADER</h1>
          <span className={`status-dot ${status === 'running' ? 'status-running' : 'status-danger'}`} />
        </div>
        <div className="flex gap-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <div>UPTIME: {formatUptime(uptime)}</div>
          <div>{new Date().toLocaleTimeString()}</div>
        </div>
      </div>

      {/* Top Stats Row */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="TOTAL EQUITY"
          value={`$${formatPrice(portfolio.totalEquity)}`}
          subtitle={formatPnLPercent(portfolio.totalPnLPercent)}
        />
        <StatCard
          label="AVAILABLE CASH"
          value={`$${formatPrice(portfolio.availableCash)}`}
        />
        <StatCard
          label="OPEN POSITIONS"
          value={openPositions.length.toString()}
        />
        <StatCard
          label="WIN RATE"
          value={formatPercent(portfolio.winRate)}
          subtitle={`${portfolio.totalTrades} trades`}
        />
      </div>

      {/* Middle Row */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        {/* Left Column */}
        <div className="space-y-4">
          {/* Live Prices */}
          <Card title="LIVE PRICES">
            <div className="space-y-3">
              {engineState.symbols.map(symbol => {
                const price = prices[symbol] || 0;
                return (
                  <div key={symbol} className="flex justify-between items-center">
                    <span className="font-bold">{symbol}</span>
                    <span className="text-lg" style={{ color: 'var(--gold)' }}>
                      ${formatPrice(price)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Market Regime */}
          <Card title="MARKET REGIME">
            <div className="space-y-4">
              {Object.values(regimes).map(regime => (
                <div key={regime.symbol} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold">{regime.symbol}</span>
                    <span
                      className="px-2 py-1 rounded text-xs"
                      style={{
                        backgroundColor: `${getVolatilityColor(regime.volatility)}33`,
                        color: getVolatilityColor(regime.volatility),
                      }}
                    >
                      {regime.volatility.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span style={{ color: 'var(--text-secondary)' }}>
                      Trend: {getTrendSymbol(regime.trend)} {regime.trend.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span style={{ color: 'var(--text-secondary)' }} className="text-sm">
                      Decision:
                    </span>
                    <div className="flex items-center gap-2">
                      <span className={`status-dot ${getDecisionStatusClass(regime.decision)}`} />
                      <span className="text-sm">{regime.decision.replace('_', ' ')}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Right Column - Open Positions */}
        <Card title="OPEN POSITIONS">
          {openPositions.length === 0 ? (
            <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
              No open positions
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
                    <th className="text-left py-2">Symbol</th>
                    <th className="text-left py-2">Dir</th>
                    <th className="text-right py-2">Entry</th>
                    <th className="text-right py-2">Current</th>
                    <th className="text-right py-2">PnL</th>
                    <th className="text-right py-2">SL</th>
                    <th className="text-right py-2">TP</th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map(pos => (
                    <tr key={pos.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="py-2">{pos.symbol}</td>
                      <td className="py-2">
                        <span style={{ color: pos.direction === 'LONG' ? 'var(--green)' : 'var(--red)' }}>
                          {pos.direction}
                        </span>
                      </td>
                      <td className="text-right">{formatPrice(pos.entryPrice)}</td>
                      <td className="text-right">{formatPrice(pos.currentPrice)}</td>
                      <td className="text-right">
                        {formatPnL(pos.unrealizedPnL)}
                        <br />
                        <span className="text-xs">{formatPnLPercent(pos.unrealizedPnLPercent)}</span>
                      </td>
                      <td className="text-right">{formatPrice(pos.stopLoss)}</td>
                      <td className="text-right">{formatPrice(pos.takeProfit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Recent Trades */}
        <Card title="RECENT TRADES">
          {closedTrades.length === 0 ? (
            <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
              No closed trades yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
                    <th className="text-left py-2">Symbol</th>
                    <th className="text-left py-2">Dir</th>
                    <th className="text-right py-2">Entry</th>
                    <th className="text-right py-2">Exit</th>
                    <th className="text-right py-2">PnL</th>
                    <th className="text-left py-2">Result</th>
                    <th className="text-left py-2">Exit</th>
                    <th className="text-right py-2">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.slice(0, 10).map(trade => (
                    <tr key={trade.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="py-2">{trade.symbol}</td>
                      <td className="py-2">
                        <span style={{ color: trade.direction === 'LONG' ? 'var(--green)' : 'var(--red)' }}>
                          {trade.direction}
                        </span>
                      </td>
                      <td className="text-right">{formatPrice(trade.entryPrice)}</td>
                      <td className="text-right">{formatPrice(trade.exitPrice)}</td>
                      <td className="text-right">
                        {formatPnL(trade.pnl)}
                        <br />
                        <span className="text-xs">{formatPnLPercent(trade.pnlPercent)}</span>
                      </td>
                      <td>
                        <span
                          className="px-2 py-0.5 rounded text-xs"
                          style={{
                            backgroundColor: trade.outcome === 'win' ? 'var(--green-dim)' : 'var(--red-dim)',
                            color: trade.outcome === 'win' ? 'var(--green)' : 'var(--red)',
                          }}
                        >
                          {trade.outcome.toUpperCase()}
                        </span>
                      </td>
                      <td className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {trade.exitReason.replace('_', ' ')}
                      </td>
                      <td className="text-right text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {formatDuration(trade.entryTime, trade.exitTime)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* LLM Decisions */}
        <Card title="LLM DECISIONS">
          {llmDecisions.length === 0 ? (
            <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
              No LLM decisions yet
            </div>
          ) : (
            <div className="space-y-3">
              {llmDecisions.slice(0, 10).map(decision => (
                <div
                  key={decision.signalId}
                  className="p-3 rounded"
                  style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="px-2 py-0.5 rounded text-xs font-bold"
                        style={{
                          backgroundColor:
                            decision.decision === 'APPROVE'
                              ? 'var(--green-dim)'
                              : decision.decision === 'REJECT'
                              ? 'var(--red-dim)'
                              : 'var(--yellow-dim)',
                          color:
                            decision.decision === 'APPROVE'
                              ? 'var(--green)'
                              : decision.decision === 'REJECT'
                              ? 'var(--red)'
                              : 'var(--yellow)',
                        }}
                      >
                        {decision.decision}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        Confidence: {(decision.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {formatTime(decision.timestamp)}
                    </span>
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {decision.reasoning.length > 120
                      ? decision.reasoning.substring(0, 120) + '...'
                      : decision.reasoning}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Footer */}
      <div className="mt-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
        Last updated: {lastUpdated?.toLocaleString() || 'Never'} | Auto-refresh: 10s
      </div>
    </div>
  );
}

// Reusable card component
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="p-4 rounded"
      style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <h2 className="text-sm font-bold mb-4" style={{ color: 'var(--text-secondary)', letterSpacing: '0.1em' }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

// Stat card component
function StatCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle?: React.ReactNode;
}) {
  return (
    <div
      className="p-4 rounded"
      style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="text-xs mb-2" style={{ color: 'var(--text-secondary)', letterSpacing: '0.1em' }}>
        {label}
      </div>
      <div className="text-2xl font-bold mb-1">{value}</div>
      {subtitle && <div className="text-sm">{subtitle}</div>}
    </div>
  );
}
