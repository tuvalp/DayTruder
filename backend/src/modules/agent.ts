import EventEmitter from 'events';
import { MarketScanner } from './scanner';
import { ResearchAgent } from './research';
import { RiskEngine } from './risk';
import { ExecutionModule } from './execution';
import { logger } from '../utils/logger';
import type { ScannerAlert, AgentState, PortfolioSnapshot, PerformanceDataPoint } from '../types';

/**
 * AlphaAgent — Autonomous Trading Orchestrator
 *
 * Wires together Scanner → Research → Risk → Execution in an async pipeline.
 * Emits 'portfolio' events whenever state changes so the WebSocket layer can
 * broadcast updates to the dashboard.
 */
export class AlphaAgent extends EventEmitter {
  private scanner: MarketScanner;
  private research: ResearchAgent;
  private risk: RiskEngine;
  private execution: ExecutionModule;

  private state: AgentState = 'idle';
  private syncInterval: NodeJS.Timeout | null = null;
  private performanceHistory: PerformanceDataPoint[] = [];
  private startingLiquidity = 0;

  constructor() {
    super();
    this.scanner = new MarketScanner();
    this.research = new ResearchAgent();
    this.execution = new ExecutionModule();
    this.risk = new RiskEngine(0); // liquidity populated on start
  }

  async start() {
    logger.info('system', '🚀 AlphaAgent initializing…');
    this.setState('scanning');

    const liquidity = await this.execution.getAccountLiquidity().catch(() => 25_000);
    this.startingLiquidity = liquidity;
    this.risk = new RiskEngine(liquidity);

    logger.info('system', `Account liquidity: $${liquidity.toLocaleString()}`);

    // Seed watchlist — in production, pull from a screener API or user config
    this.scanner.setWatchlist(DEFAULT_WATCHLIST);
    this.scanner.on('alert', (alert: ScannerAlert) => this.handleAlert(alert));
    this.scanner.start();

    // Sync positions every 5 seconds
    this.syncInterval = setInterval(() => this.syncAndEmit(), 5000);

    logger.success('system', '✅ AlphaAgent is LIVE and scanning the market.');
  }

  pause() {
    this.setState('paused');
    this.scanner.stop();
    if (this.syncInterval) clearInterval(this.syncInterval);
    logger.warn('system', '⏸  AlphaAgent paused — no new entries will be made.');
  }

  resume() {
    this.start();
  }

  private async handleAlert(alert: ScannerAlert) {
    if (this.state === 'paused') return;
    if (this.risk.isCircuitBreakerActive) return;

    this.setState('researching');
    logger.info('system', `Pipeline triggered for ${alert.symbol}`);

    // --- Step 1: AI Catalyst Research ---
    const catalyst = await this.research.analyze(alert).catch((err) => {
      logger.error('research', `Analysis failed for ${alert.symbol}: ${err}`);
      return null;
    });
    if (!catalyst) { this.setState('scanning'); return; }

    if (catalyst.score < 50) {
      logger.warn('system', `${alert.symbol} skipped — low catalyst score (${catalyst.score}/100).`);
      this.setState('scanning');
      return;
    }

    // --- Step 2: Risk Sizing ---
    this.setState('executing');
    const openCount = this.execution.getOpenPositions().length;
    const sizing = this.risk.size(alert.symbol, alert.price, catalyst, openCount);
    if (!sizing) { this.setState('monitoring'); return; }

    // --- Step 3: Execute ---
    const position = await this.execution.submitBracketOrder(sizing, catalyst);
    if (position) {
      logger.trade(
        'system',
        `✅ TRADE OPENED: ${alert.symbol} | ${sizing.shares} shares | SL $${sizing.stopLoss.toFixed(2)} | TP1 $${sizing.takeProfits[0].toFixed(2)}`,
        { position }
      );
      this.emit('trade', position);
    }

    this.setState(this.execution.getOpenPositions().length > 0 ? 'monitoring' : 'scanning');
  }

  private async syncAndEmit() {
    await this.execution.syncPositions().catch(() => null);

    const openPositions = this.execution.getOpenPositions();
    const dailyUnrealized = openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const liquidity = await this.execution.getAccountLiquidity().catch(() => this.startingLiquidity);
    this.risk.updateLiquidity(liquidity);

    const snapshot: PortfolioSnapshot = {
      netLiquidity: liquidity,
      dailyRealizedPnl: 0,  // wire to RiskEngine.recordPnl accumulator
      dailyUnrealizedPnl: dailyUnrealized,
      dailyPnlPct: ((liquidity - this.startingLiquidity) / this.startingLiquidity) * 100,
      openPositions,
      activeRiskMultiplier: this.risk.activeRiskMultiplier,
      snapshotAt: Date.now(),
    };

    this.performanceHistory.push({
      timestamp: Date.now(),
      equity: liquidity,
      pnl: snapshot.dailyPnlPct,
    });
    if (this.performanceHistory.length > 390) this.performanceHistory.shift(); // ~6.5 h of minute bars

    this.emit('portfolio', snapshot);
    this.emit('performance', this.performanceHistory);
  }

  private setState(state: AgentState) {
    this.state = state;
    this.emit('state', state);
  }

  getState(): AgentState { return this.state; }
  getPerformanceHistory(): PerformanceDataPoint[] { return [...this.performanceHistory]; }
}

// Default universe of low-float micro-caps to monitor.
// In production, replace with a dynamic screener feed.
const DEFAULT_WATCHLIST = [
  'CLOV', 'ATER', 'PROG', 'BBIG', 'EXPR', 'MRIN', 'PHUN', 'VVPR',
  'GFAI', 'SOPA', 'MULN', 'EEIQ', 'CLPS', 'CLRB', 'BLNK',
];
