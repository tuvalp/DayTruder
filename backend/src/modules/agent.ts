import EventEmitter from 'events';
import { IBApi, EventName } from '@stoqey/ib';
import { MarketScanner } from './scanner';
import { PolygonScreener } from './screener';
import { ResearchAgent } from './research';
import { isMarketOpen, getMarketStatus } from '../utils/marketHours';
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
      if ([162, 300, 365, 2104, 2106, 2158, 2119, 10089, 10147, 10167, 10168].includes(code)) return;
      // 200 = no security definition — symbol is unresolvable (warrant, OTC, etc.)
      if ((code as unknown as number) === 200) {
        const sym = this.scanner.dropByReqId(reqId);
        if (sym) logger.warn('scanner', `${sym} removed — IBKR cannot resolve contract (error 200)`);
        return;
      }
      // 202 = order cancelled — if it's a pending entry, clean up the position
      if ((code as unknown as number) === 202) {
        const sym = this.execution.handleOrderCancelled(reqId as number);
        if (sym) {
          logger.warn('execution', `${sym} entry order cancelled by IBKR (202) — resetting to watching`);
          this.scanner.setStrategy(sym, 'watching');
          this.setState(this.execution.getOpenPositions().filter((p) => p.status === 'open').length > 0 ? 'monitoring' : 'scanning');
        }
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

    const status = getMarketStatus();
    const openMsg = status === 'open'
      ? '🟢 Market is OPEN — entries enabled'
      : `🔴 Market is ${status.toUpperCase()} — entries will be blocked until 9:30 AM ET`;
    logger.info('system', openMsg);

    // Emit market status every minute
    setInterval(() => {
      const s = getMarketStatus();
      this.emit('marketStatus', s);
    }, 60_000);
    this.emit('marketStatus', status);

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

    // ── Market hours gate ─────────────────────────────────────────────────────
    if (!isMarketOpen()) {
      logger.info('system', `${alert.symbol} alert ignored — market is ${getMarketStatus()}`);
      return;
    }

    // ── Minimum cash gate: block only if truly nothing to trade with ──────────
    const availableCash = this.execution.getAvailableCash();
    if (availableCash > 0 && availableCash < 50) {
      logger.warn('risk', `${alert.symbol} rejected — available cash $${availableCash.toFixed(0)} is too low to trade`);
      return;
    }
    // Position sizing and cash-cap happen inside risk.size() — no pre-rejection needed

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
      this.scanner.setStrategy(alert.symbol, 'ordering');
      logger.trade(
        'system',
        `⏳ ORDER SUBMITTED: ${alert.symbol} | ${sizing.shares} sh @ ~$${sizing.entryPrice.toFixed(2)} | SL $${sizing.stopLoss.toFixed(2)} | TP1 $${sizing.takeProfits[0].toFixed(2)} — waiting for fill`,
        { position }
      );
      this.emit('trade', position);

      // Timers — declared up-front so the fill callback can clear them
      let chaseTimer: NodeJS.Timeout;
      let cancelTimer: NodeJS.Timeout;

      // Single onEntryFilled registration — clears both timers, marks positioned
      this.execution.onEntryFilled = (symbol, fillPrice) => {
        if (symbol !== alert.symbol) return;
        clearTimeout(chaseTimer);
        clearTimeout(cancelTimer);
        logger.trade('system', `✅ POSITION OPEN: ${symbol} filled @ $${fillPrice.toFixed(2)}`);
        this.scanner.setStrategy(symbol, 'positioned');
        this.emitPositions();
        this.setState('monitoring');
      };

      // 30 s: chase unfilled entry — bump limit price 1.5% toward market
      chaseTimer = setTimeout(() => {
        const stillPending = this.execution.getOpenPositions()
          .find((p) => p.symbol === alert.symbol && p.status === 'pending');
        if (!stillPending) return;
        const newLimit = parseFloat((sizing.entryPrice * 1.015).toFixed(2));
        logger.warn('execution', `${alert.symbol} entry not filled after 30 s — chasing @ $${newLimit}`);
        this.execution.chaseEntryOrder(alert.symbol, newLimit);
      }, 30_000);

      // 60 s: give up — cancel the whole bracket and reset
      cancelTimer = setTimeout(() => {
        const stillPending = this.execution.getOpenPositions()
          .find((p) => p.symbol === alert.symbol && p.status === 'pending');
        if (!stillPending) return;
        logger.warn('execution', `${alert.symbol} entry not filled after 60 s — cancelling`);
        this.execution.cancelPendingEntry(alert.symbol);
        this.scanner.setStrategy(alert.symbol, 'watching');
        this.setState(this.execution.getOpenPositions().filter((p) => p.status === 'open').length > 0 ? 'monitoring' : 'scanning');
      }, 60_000);
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
    this.risk.updateAvailableCash(this.execution.getAvailableCash());

    const snapshot: PortfolioSnapshot = {
      netLiquidity: liquidity,
      availableCash: this.execution.getAvailableCash(),
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
   *   2. Early breakeven: once up half a stop-loss %, move stop to entry → zero risk
   *   3. TP1 hit → sell 50%, stop → breakeven (if not already)
   *   4. TP2 hit → sell 25% more, stop → TP1 (locked profit floor)
   *   5. Post-TP1 trailing: trail 5% below session high once any TP hit
   *   6. Trailing stop: once up 20%+, trail 8% below session high
   *   7. Reversal exit: up > half-stop% and pulls back 6%+ from high without TP
   */
  private manageOpenPositions() {
    const s = settingsStore.get();
    const positions = this.execution.getOpenPositions().filter((p) => p.status === 'open');
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

      // ── Early breakeven: half a stop above entry → stop to entry price ───────
      // Eliminates downside risk as soon as there's a small cushion
      const breakEvenTriggerPct = s.stopLossPct / 2;
      if (!pos.tp1Hit && pctFromEntry >= breakEvenTriggerPct && pos.stopLoss < pos.avgPrice) {
        this.execution.adjustStop(pos.symbol, pos.avgPrice);
        logger.trade('system', `🔒 ${pos.symbol} stop → breakeven $${pos.avgPrice.toFixed(2)} (up ${pctFromEntry.toFixed(1)}%)`);
        changed = true;
      }

      // ── TP1: sell half, tighten stop to breakeven ────────────────────────────
      if (!pos.tp1Hit && tp1 && price >= tp1) {
        pos.tp1Hit = true;
        const half = Math.max(1, Math.floor(pos.shares / 2));
        this.execution.partialSell(pos.symbol, half, `TP1 hit @ $${price.toFixed(2)} (+${pctFromEntry.toFixed(1)}%)`);
        this.execution.adjustStop(pos.symbol, pos.avgPrice);
        logger.trade('system', `📈 ${pos.symbol} TP1 — sold ${half} sh, stop → breakeven $${pos.avgPrice.toFixed(2)}`);
        changed = true;
      }

      // ── TP2: sell half of remainder, stop → TP1 (locked profit) ─────────────
      else if (pos.tp1Hit && !pos.tp2Hit && tp2 && price >= tp2) {
        pos.tp2Hit = true;
        const quarter = Math.max(1, Math.floor(pos.shares / 2));
        this.execution.partialSell(pos.symbol, quarter, `TP2 hit @ $${price.toFixed(2)} (+${pctFromEntry.toFixed(1)}%)`);
        if (tp1) this.execution.adjustStop(pos.symbol, tp1);
        logger.trade('system', `🚀 ${pos.symbol} TP2 — sold ${quarter} sh, stop → TP1 $${tp1?.toFixed(2)}`);
        changed = true;
      }

      // ── Post-TP1 tight trail: once any profit locked, trail 5% from high ─────
      else if (pos.tp1Hit && pos.sessionHigh) {
        const tightTrail = parseFloat((pos.sessionHigh * 0.95).toFixed(2));
        if (tightTrail > pos.stopLoss) {
          this.execution.adjustStop(pos.symbol, tightTrail);
          logger.info('system', `↗ ${pos.symbol} tight trail → $${tightTrail.toFixed(2)} (high $${pos.sessionHigh.toFixed(2)})`);
          changed = true;
        }
      }

      // ── Wide trailing stop: once up 20%+, trail 8% below session high ────────
      else if (!pos.tp1Hit && pctFromEntry > 20 && pos.sessionHigh) {
        const trailStop = parseFloat((pos.sessionHigh * 0.92).toFixed(2));
        if (trailStop > pos.stopLoss) {
          this.execution.adjustStop(pos.symbol, trailStop);
          logger.info('system', `↗ ${pos.symbol} trailing stop → $${trailStop.toFixed(2)} (high $${pos.sessionHigh.toFixed(2)})`);
          changed = true;
        }
      }

      // ── Reversal exit: profitable position pulls back hard without any TP ─────
      if (
        pos.sessionHigh &&
        pctFromEntry > breakEvenTriggerPct &&
        pctFromHigh < -6 &&
        !pos.tp1Hit
      ) {
        logger.trade('system', `⚠️  ${pos.symbol} reversal — up ${pctFromEntry.toFixed(1)}% but -${Math.abs(pctFromHigh).toFixed(1)}% from high. Exiting.`);
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
