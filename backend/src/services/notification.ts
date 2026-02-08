// ============================================
// NOTIFICATION SERVICE - Email Alerts
// ============================================

import { Resend } from 'resend';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { TradeSignal, LLMFilterResult, ClosedTrade, Position } from '../types/index.js';

export class NotificationService {
  private resend: Resend | null = null;
  private readonly to: string;
  private readonly from: string;
  private readonly enabled: boolean;

  constructor() {
    this.to = env.NOTIFICATION_EMAIL;
    this.from = env.RESEND_FROM_EMAIL;
    this.enabled = !!env.RESEND_API_KEY && !!env.NOTIFICATION_EMAIL;

    if (this.enabled) {
      this.resend = new Resend(env.RESEND_API_KEY);
      logger.info('NotificationService', `Email notifications enabled → ${this.to}`);
    } else {
      logger.warn('NotificationService', 'Email notifications disabled (missing RESEND_API_KEY or NOTIFICATION_EMAIL)');
    }
  }

  /** Trade executed - position opened */
  async tradeOpened(position: Position, signal: TradeSignal, llm: LLMFilterResult): Promise<void> {
    const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
    const subject = `${emoji} ${signal.direction} ${signal.symbol} @ $${position.entryPrice.toFixed(2)}`;

    const html = `
      <div style="font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px;">
        <h2 style="color: ${signal.direction === 'LONG' ? '#00e676' : '#ff1744'}; margin-top: 0;">
          ${emoji} Trade Opened: ${signal.direction} ${signal.symbol}
        </h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 6px 0; color: #888;">Entry Price</td><td style="padding: 6px 0;">$${position.entryPrice.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Stop Loss</td><td style="padding: 6px 0; color: #ff1744;">$${position.stopLoss.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Take Profit</td><td style="padding: 6px 0; color: #00e676;">$${position.takeProfit.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Quantity</td><td style="padding: 6px 0;">${position.quantity.toFixed(6)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Signal Strength</td><td style="padding: 6px 0;">${signal.strength.toUpperCase()}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Risk/Reward</td><td style="padding: 6px 0;">${signal.riskRewardRatio.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">LLM Confidence</td><td style="padding: 6px 0;">${(llm.confidence * 100).toFixed(0)}%</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">LLM Reasoning</td><td style="padding: 6px 0; font-size: 12px;">${llm.reasoning}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Signal Reason</td><td style="padding: 6px 0; font-size: 12px;">${signal.reason}</td></tr>
        </table>
      </div>
    `;

    await this.send(subject, html);
  }

  /** Trade rejected by LLM */
  async tradeRejected(signal: TradeSignal, llm: LLMFilterResult): Promise<void> {
    const subject = `⛔ REJECTED: ${signal.direction} ${signal.symbol} @ $${signal.entryPrice.toFixed(2)}`;

    const html = `
      <div style="font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px;">
        <h2 style="color: #ff9100; margin-top: 0;">⛔ Trade Rejected by LLM</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 6px 0; color: #888;">Symbol</td><td style="padding: 6px 0;">${signal.symbol}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Direction</td><td style="padding: 6px 0;">${signal.direction}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Entry Price</td><td style="padding: 6px 0;">$${signal.entryPrice.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Decision</td><td style="padding: 6px 0; color: #ff1744;">${llm.decision}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Confidence</td><td style="padding: 6px 0;">${(llm.confidence * 100).toFixed(0)}%</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Reasoning</td><td style="padding: 6px 0; font-size: 12px;">${llm.reasoning}</td></tr>
          ${llm.delayMinutes ? `<tr><td style="padding: 6px 0; color: #888;">Delay</td><td style="padding: 6px 0;">${llm.delayMinutes} dakika</td></tr>` : ''}
          <tr><td style="padding: 6px 0; color: #888;">Signal Reason</td><td style="padding: 6px 0; font-size: 12px;">${signal.reason}</td></tr>
        </table>
      </div>
    `;

    await this.send(subject, html);
  }

  /** Trade closed - position exited */
  async tradeClosed(trade: ClosedTrade): Promise<void> {
    const isWin = trade.outcome === 'win';
    const emoji = isWin ? '💰' : '📉';
    const color = isWin ? '#00e676' : '#ff1744';
    const subject = `${emoji} CLOSED: ${trade.symbol} ${trade.direction} | PnL: $${trade.pnl.toFixed(2)} (${trade.pnlPercent.toFixed(2)}%)`;

    const html = `
      <div style="font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px;">
        <h2 style="color: ${color}; margin-top: 0;">${emoji} Trade Closed: ${trade.symbol}</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 6px 0; color: #888;">Direction</td><td style="padding: 6px 0;">${trade.direction}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Entry</td><td style="padding: 6px 0;">$${trade.entryPrice.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Exit</td><td style="padding: 6px 0;">$${trade.exitPrice.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">PnL</td><td style="padding: 6px 0; color: ${color}; font-size: 18px; font-weight: bold;">$${trade.pnl.toFixed(2)} (${trade.pnlPercent.toFixed(2)}%)</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Outcome</td><td style="padding: 6px 0; color: ${color};">${trade.outcome.toUpperCase()}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Exit Reason</td><td style="padding: 6px 0;">${trade.exitReason}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Commission</td><td style="padding: 6px 0;">$${trade.commission.toFixed(4)}</td></tr>
          ${trade.postTradeAnalysis ? `<tr><td style="padding: 6px 0; color: #888;">Post-Trade Analysis</td><td style="padding: 6px 0; font-size: 12px;">${trade.postTradeAnalysis}</td></tr>` : ''}
        </table>
      </div>
    `;

    await this.send(subject, html);
  }

  /** Signal generated (before LLM filter) */
  async signalGenerated(signal: TradeSignal): Promise<void> {
    const emoji = signal.direction === 'LONG' ? '📈' : '📉';
    const subject = `${emoji} Signal: ${signal.direction} ${signal.symbol} (${signal.strength})`;

    const html = `
      <div style="font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px;">
        <h2 style="color: #448aff; margin-top: 0;">${emoji} New Signal Detected</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 6px 0; color: #888;">Symbol</td><td style="padding: 6px 0;">${signal.symbol}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Direction</td><td style="padding: 6px 0;">${signal.direction}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Strength</td><td style="padding: 6px 0;">${signal.strength.toUpperCase()}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Entry</td><td style="padding: 6px 0;">$${signal.entryPrice.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Stop Loss</td><td style="padding: 6px 0;">$${signal.stopLoss.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Take Profit</td><td style="padding: 6px 0;">$${signal.takeProfit.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">R/R</td><td style="padding: 6px 0;">${signal.riskRewardRatio.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888;">Reason</td><td style="padding: 6px 0; font-size: 12px;">${signal.reason}</td></tr>
        </table>
        <p style="color: #888; font-size: 11px; margin-bottom: 0;">LLM filter'a gönderiliyor...</p>
      </div>
    `;

    await this.send(subject, html);
  }

  /** Engine started */
  async engineStarted(): Promise<void> {
    const subject = '🚀 Crypto Trader Engine Started';
    const html = `
      <div style="font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px;">
        <h2 style="color: #00e676; margin-top: 0;">🚀 Trading Engine Started</h2>
        <p>BTC/USDT ve ETH/USDT izleniyor.</p>
        <p style="color: #888; font-size: 12px;">15m candle resolution | Paper trading | $10,000 USDT</p>
        <p style="color: #888; font-size: 11px;">${new Date().toISOString()}</p>
      </div>
    `;
    await this.send(subject, html);
  }

  /** Engine error */
  async engineError(message: string): Promise<void> {
    const subject = `🔥 Engine Error: ${message.slice(0, 60)}`;
    const html = `
      <div style="font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px;">
        <h2 style="color: #ff1744; margin-top: 0;">🔥 Engine Error</h2>
        <p>${message}</p>
        <p style="color: #888; font-size: 11px;">${new Date().toISOString()}</p>
      </div>
    `;
    await this.send(subject, html);
  }

  private async send(subject: string, html: string): Promise<void> {
    if (!this.enabled || !this.resend) {
      return;
    }

    try {
      await this.resend.emails.send({
        from: this.from,
        to: this.to,
        subject,
        html,
      });
      logger.info('NotificationService', `Email sent: ${subject}`);
    } catch (error) {
      logger.error('NotificationService', 'Failed to send email', error);
    }
  }
}
