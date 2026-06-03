import EventEmitter from 'events';
import { IBApi, EventName } from '@stoqey/ib';
import { MarketScanner } from './scanner';
import { PolygonScreener } from './screener';
import { ResearchAgent } from './research';
import { RiskEngine } from './risk';
import { ExecutionModule } from './execution';
import { config } from '../config';
import { logger } from '../utils/logger';
import { settingsStore } from './settings';
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
  private screener: PolygonScreener;
  private research: ResearchAgent;
  private risk: RiskEngine;
  private execution: ExecutionModule;

  private lastLiquidityFetch: number | null = null;
  private state: AgentState = 'idle';
  private syncInterval: NodeJS.Timeout | null = null;
  private performanceHistory: PerformanceDataPoint[] = [];
  private startingLiquidity = 0;
  private cachedLiquidity = 0;
  private ibConnected = false;

  constructor() {
    super();
    this.ib = new IBApi({
      host: config.IBKR_HOST,
      port: config.IBKR_PORT,
      clientId: config.IBKR_CLIENT_ID,
    });

    this.scanner  = new MarketScanner(this.ib);
    this.screener = new PolygonScreener();
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
      if ([162, 300, 365, 2104, 2106, 2158, 2119, 10089, 10167, 10168].includes(code)) return;
      // 200 = no security definition — symbol is unresolvable (warrant, OTC, etc.)
      // Drop it from the scanner so it doesn't stay on the watchlist
      if ((code as unknown as number) === 200) {
        const sym = this.scanner.dropByReqId(reqId);
        if (sym) logger.warn('scanner', `${sym} removed — IBKR cannot resolve contract (error 200)`);
        return;
      }
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
    this.cachedLiquidity = liquidity;
    this.risk = new RiskEngine(liquidity);
    logger.success('system', `Account net liquidity: $${liquidity.toLocaleString()}`);

    // Sync open positions and orders from IBKR (handles restarts gracefully)
    await this.execution.syncPositionsFromIBKR();
    await this.execution.syncOpenOrdersFromIBKR();

    // Subscribe live price ticks for every open position; re-emit on each update
    this.execution.startLiveTracking(() => this.emitPositions());

    this.scanner.on('alert', (alert: ScannerAlert) => this.handleAlert(alert));
    this.scanner.on('watchlist', (entries) => this.emit('watchlist', entries));
    this.scanner.start();

    // Polygon screener drives the entire watchlist — polls every 30 s for today's movers
    this.screener.start((results) => {
      this.scanner.ingestSymbols(results.map((r) => ({ symbol: r.symbol, float: r.float, price: r.price })));
    });

    this.syncInterval = setInterval(() => this.syncAndEmit(), 5000);
    setInterval(() => this.manageOpenPositions(), 5000);
    logger.success('system', '✅ AlphaAgent is LIVE and scanning the market.');
  }

  pause() {
    this.setState('paused');
    this.scanner.stop();
    this.screener.stop();
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

  async handleManualBuy(symbol: string, price: number) {
    const fakeAlert: ScannerAlert = {
      symbol, price, priceChangePct: 0, volume: 0, relativeVolume: 0,
      float: 10, marketCap: price * 10_000_000, timestamp: Date.now(),
      triggerReasons: ['Manual trigger'],
    };
    logger.warn('system', `⚡ Manual pipeline trigger: ${symbol} @ $${price}`);
    await this.handleAlert(fakeAlert);
  }

  private async handleAlert(alert: ScannerAlert) {
    if (this.state === 'paused') return;
    if (this.risk.isCircuitBreakerActive) return;

    this.scanner.setStrategy(alert.symbol, 'alert');

    // ── Profit margin pre-check (no Claude API call wasted) ──────────────────
    const marginReject = this.risk.checkProfitMargin(alert);
    if (marginReject) {
      logger.warn('risk', `${alert.symbol} rejected before research — ${marginReject}`);
      this.scanner.setStrategy(alert.symbol, 'rejected');
      return;
    }

    this.setState('researching');
    this.scanner.setStrategy(alert.symbol, 'researching');

    const catalyst = await this.research.analyze(alert).catch((err) => {
      logger.error('research', `Analysis failed for ${alert.symbol}: ${err}`);
      return null;
    });
    if (!catalyst) {
      this.scanner.setStrategy(alert.symbol, 'watching');
      this.setState('scanning'); return;
    }

    const { minCatalystScore } = settingsStore.get();
    if (catalyst.score < minCatalystScore) {
      logger.warn('system', `${alert.symbol} skipped — catalyst score ${catalyst.score}/100 below threshold (${minCatalystScore}).`);
      this.scanner.setStrategy(alert.symbol, 'rejected');
      this.setState('scanning');
      return;
    }

    this.setState('executing');
    this.scanner.setStrategy(alert.symbol, 'sizing');
    const openCount = this.execution.getOpenPositions().length;
    const sizing = this.risk.size(alert.symbol, alert.price, catalyst, openCount, alert);
    if (!sizing) {
      this.scanner.setStrategy(alert.symbol, 'rejected');
      this.setState('monitoring'); return;
    }

    const position = await this.execution.submitBracketOrder(sizing, catalyst);
    if (position) {
      this.scanner.setStrategy(alert.symbol, 'positioned');
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

    // Refresh liquidity from IBKR every 60 s, not every 5 s — only log when it changes
    const now = Date.now();
    if (!this.lastLiquidityFetch || now - this.lastLiquidityFetch > 60_000) {
      this.lastLiquidityFetch = now;
      const fresh = await this.execution.getAccountLiquidity().catch(() => this.cachedLiquidity);
      if (fresh !== this.cachedLiquidity) {
        logger.info('system', `Net liquidity updated: $${fresh.toLocaleString()}`);
        this.cachedLiquidity = fresh;
      }
    }
    const liquidity = this.cachedLiquidity;
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
    this.emitPositions();
  }

  emitPositions() {
    this.emit('positions', this.execution.getOpenPositions());
    this.emit('orders', this.execution.getOpenOrders());
  }

  /**
   * Active position management — runs every 5 s.
   *
   * For each open position:
   *   1. Track session high
   *   2. TP1 hit → sell 50%, move stop to breakeven
   *   3. TP2 hit → sell 25% more, trail stop above TP1
   *   4. Reversal → if up > 10% then pulls back 6%+ from session high, exit to lock gains
   *   5. Trailing stop → once up 20%, trail by 8% below session high
   */
  private manageOpenPositions() {
    const s = settingsStore.get();
    const positions = this.execution.getOpenPositions();
    if (positions.length === 0) return;

    let changed = false;

    for (const pos of positions) {
      const price = pos.currentPrice;
      if (price <= 0 || pos.avgPrice <= 0) continue;

      const pctFromEntry = ((price - pos.avgPrice) / pos.avgPrice) * 100;
      const tp1 = pos.takeProfits[0];
      const tp2 = pos.takeProfits[1];

      // Track session high
      if (!pos.sessionHigh || price > pos.sessionHigh) {
        pos.sessionHigh = price;
      }

      const pctFromHigh = pos.sessionHigh > 0
        ? ((price - pos.sessionHigh) / pos.sessionHigh) * 100
        : 0;

      // ── TP1: sell half, move stop to breakeven ──────────────────────────────
      if (!pos.tp1Hit && tp1 && price >= tp1) {
        pos.tp1Hit = true;
        const half = Math.max(1, Math.floor(pos.shares / 2));
        this.execution.partialSell(pos.symbol, half, `TP1 hit @ $${price.toFixed(2)} (+${pctFromEntry.toFixed(1)}%)`);
        this.execution.adjustStop(pos.symbol, pos.avgPrice);  // stop → breakeven
        logger.trade('system', `📈 ${pos.symbol} TP1 — sold ${half} sh, stop → breakeven $${pos.avgPrice.toFixed(2)}`);
        changed = true;
      }

      // ── TP2: sell half of remainder, trail stop above TP1 ──────────────────
      else if (pos.tp1Hit && !pos.tp2Hit && tp2 && price >= tp2) {
        pos.tp2Hit = true;
        const quarter = Math.max(1, Math.floor(pos.shares / 2));
        this.execution.partialSell(pos.symbol, quarter, `TP2 hit @ $${price.toFixed(2)} (+${pctFromEntry.toFixed(1)}%)`);
        if (tp1) this.execution.adjustStop(pos.symbol, tp1);  // stop → TP1 level
        logger.trade('system', `🚀 ${pos.symbol} TP2 — sold ${quarter} sh, stop → TP1 $${tp1?.toFixed(2)}`);
        changed = true;
      }

      // ── Trailing stop: once up 20%+, trail 8% below session high ───────────
      else if (pctFromEntry > 20 && pos.sessionHigh) {
        const trailStop = parseFloat((pos.sessionHigh * 0.92).toFixed(2));
        if (trailStop > pos.stopLoss) {
          this.execution.adjustStop(pos.symbol, trailStop);
          logger.info('system', `↗ ${pos.symbol} trailing stop → $${trailStop.toFixed(2)} (high $${pos.sessionHigh.toFixed(2)})`);
          changed = true;
        }
      }

      // ── Reversal exit: profitable position pulls back hard from session high ─
      // Only fires if we're up enough to still profit after commissions
      if (
        pos.sessionHigh &&
        pctFromEntry > (s.stopLossPct / 2) &&  // already more than half a stop above entry
        pctFromHigh < -6 &&                     // pulled back 6%+ from high
        !pos.tp1Hit                              // haven't taken any profit yet
      ) {
        logger.trade('system', `⚠️  ${pos.symbol} reversal detected — up ${pctFromEntry.toFixed(1)}% but -${Math.abs(pctFromHigh).toFixed(1)}% from high. Exiting to lock profit.`);
        this.execution.closePosition(pos.symbol);
        this.scanner.setStrategy(pos.symbol, 'watching');
        changed = true;
      }
    }

    if (changed) this.emitPositions();
  }

  private setState(state: AgentState) {
    this.state = state;
    this.emit('state', state);
  }

  getState(): AgentState { return this.state; }
  getPerformanceHistory(): PerformanceDataPoint[] { return [...this.performanceHistory]; }
}
