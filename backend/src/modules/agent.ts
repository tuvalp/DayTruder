import EventEmitter from 'events';
import { IBApi, EventName } from '@stoqey/ib';
import { MarketScanner } from './scanner';
import { ResearchAgent } from './research';
import { RiskEngine } from './risk';
import { ExecutionModule } from './execution';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { ScannerAlert, AgentState, PortfolioSnapshot, PerformanceDataPoint } from '../types';

/**
 * AlphaAgent — Autonomous Trading Orchestrator
 *
 * Owns the single IBApi connection shared by Scanner and ExecutionModule.
 * Pipeline: Scanner → Research → Risk → Execution → Socket.IO broadcast.
 */
export class AlphaAgent extends EventEmitter {
  private ib: IBApi;
  private scanner: MarketScanner;
  private research: ResearchAgent;
  private risk: RiskEngine;
  private execution: ExecutionModule;

  private state: AgentState = 'idle';
  private syncInterval: NodeJS.Timeout | null = null;
  private performanceHistory: PerformanceDataPoint[] = [];
  private startingLiquidity = 0;
  private ibConnected = false;

  constructor() {
    super();
    this.ib = new IBApi({
      host: config.IBKR_HOST,
      port: config.IBKR_PORT,
      clientId: config.IBKR_CLIENT_ID,
    });

    this.scanner  = new MarketScanner(this.ib);
    this.research = new ResearchAgent();
    this.execution = new ExecutionModule(this.ib);
    this.risk = new RiskEngine(0);

    this.ib.on(EventName.connected, () => {
      this.ibConnected = true;
      logger.success('system', `Connected to IBKR TWS (${config.IBKR_HOST}:${config.IBKR_PORT})`);
    });

    this.ib.on(EventName.disconnected, () => {
      this.ibConnected = false;
      logger.error('system', 'IBKR connection lost — attempting reconnect in 5 s…');
      setTimeout(() => this.connectIB(), 5000);
    });

    this.ib.on(EventName.error, (_err, code, reqId) => {
      // Informational / transient codes — suppress
      // 2104/2106/2158/2119 = market data farm connection notices
      // 162 = scanner/historical pacing — harmless when filterOptions is empty
      if ([162, 2104, 2106, 2158, 2119].includes(code)) return;
      logger.error('system', `IBKR error code ${code} (reqId ${reqId})`);
    });
  }

  async start() {
    logger.info('system', '🚀 AlphaAgent initializing…');
    this.setState('scanning');

    if (!this.ibConnected) {
      this.connectIB();
      await this.waitForConnection();
    }

    const liquidity = await this.execution.getAccountLiquidity();
    this.startingLiquidity = liquidity;
    this.risk = new RiskEngine(liquidity);
    logger.success('system', `Account net liquidity: $${liquidity.toLocaleString()}`);

    this.scanner.on('alert', (alert: ScannerAlert) => this.handleAlert(alert));
    this.scanner.start();

    this.syncInterval = setInterval(() => this.syncAndEmit(), 5000);
    logger.success('system', '✅ AlphaAgent is LIVE and scanning the market.');
  }

  pause() {
    this.setState('paused');
    this.scanner.stop();
    if (this.syncInterval) clearInterval(this.syncInterval);
    logger.warn('system', '⏸  AlphaAgent paused — no new entries.');
  }

  resume() { this.start(); }

  private connectIB() {
    try {
      this.ib.connect();
    } catch (err) {
      logger.error('system', `IBApi connect() failed: ${String(err)}`);
    }
  }

  private waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.ibConnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('IBKR connection timeout')), timeoutMs);
      this.ib.once(EventName.connected, () => { clearTimeout(t); resolve(); });
    });
  }

  private async handleAlert(alert: ScannerAlert) {
    if (this.state === 'paused') return;
    if (this.risk.isCircuitBreakerActive) return;

    this.setState('researching');

    const catalyst = await this.research.analyze(alert).catch((err) => {
      logger.error('research', `Analysis failed for ${alert.symbol}: ${err}`);
      return null;
    });
    if (!catalyst) { this.setState('scanning'); return; }

    if (catalyst.score < 50) {
      logger.warn('system', `${alert.symbol} skipped — catalyst score ${catalyst.score}/100.`);
      this.setState('scanning');
      return;
    }

    this.setState('executing');
    const openCount = this.execution.getOpenPositions().length;
    const sizing = this.risk.size(alert.symbol, alert.price, catalyst, openCount);
    if (!sizing) { this.setState('monitoring'); return; }

    const position = await this.execution.submitBracketOrder(sizing, catalyst);
    if (position) {
      logger.trade(
        'system',
        `✅ TRADE OPENED: ${alert.symbol} | ${sizing.shares} sh | SL $${sizing.stopLoss.toFixed(2)} | TP1 $${sizing.takeProfits[0].toFixed(2)}`,
        { position }
      );
      this.emit('trade', position);
    }

    this.setState(this.execution.getOpenPositions().length > 0 ? 'monitoring' : 'scanning');
  }

  private async syncAndEmit() {
    const openPositions = this.execution.getOpenPositions();
    const dailyUnrealized = openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const liquidity = await this.execution.getAccountLiquidity().catch(() => this.startingLiquidity);
    this.risk.updateLiquidity(liquidity);

    const snapshot: PortfolioSnapshot = {
      netLiquidity: liquidity,
      dailyRealizedPnl: 0,
      dailyUnrealizedPnl: dailyUnrealized,
      dailyPnlPct: ((liquidity - this.startingLiquidity) / this.startingLiquidity) * 100,
      openPositions,
      activeRiskMultiplier: this.risk.activeRiskMultiplier,
      snapshotAt: Date.now(),
    };

    this.performanceHistory.push({ timestamp: Date.now(), equity: liquidity, pnl: snapshot.dailyPnlPct });
    if (this.performanceHistory.length > 390) this.performanceHistory.shift();

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
