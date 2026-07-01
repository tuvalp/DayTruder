import EventEmitter from 'events';
import { IBApi, EventName } from '@stoqey/ib';
import { MarketScanner } from './scanner';
import { PolygonScreener } from './screener';
import { ResearchAgent } from './research';
import { isMarketOpen, getMarketStatus, minutesUntilOpen, minutesUntilClose } from '../utils/marketHours';
import { RiskEngine } from './risk';
import { ExecutionModule } from './execution';
import { config } from '../config';
import { logger } from '../utils/logger';
import { settingsStore } from './settings';
import type { ScannerAlert, AgentState, PortfolioSnapshot, PerformanceDataPoint, TradeExecution } from '../types';

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
  // Symbols currently running through the pipeline — prevents duplicate concurrent processing
  private inPipeline = new Set<string>();
  private performanceHistory: PerformanceDataPoint[] = [];
  private startingLiquidity = 0;
  private cachedLiquidity = 0;
  private ibConnected = false;
  // Infra (IBKR connection, screener wiring, sync loops) is connected once at boot
  private infraReady = false;
  // Trading session (scanner running, alerts producing entries) toggles on schedule
  private tradingActive = false;
  // Set when the user manually pauses — the schedule loop won't override it
  private manuallyPaused = false;
  private scheduleInterval: NodeJS.Timeout | null = null;
  private readonly minAvailableCash = 50;

  constructor() {
    super();
    this.ib = new IBApi({
      host: config.IBKR_HOST,
      port: config.IBKR_PORT,
      clientId: config.IBKR_CLIENT_ID,
    });

    this.screener = new PolygonScreener();
    this.scanner  = new MarketScanner(this.ib, this.screener);  // scanner owns the screener stream
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
      const errMsg = (_err as { message?: string } | string | undefined) && typeof _err === 'object' ? (_err as { message?: string }).message : String(_err ?? '');
      // Informational / transient codes — suppress
      if ([162, 300, 365, 2104, 2106, 2158, 2119, 10089, 10147, 10167, 10168,
           104,  // can't modify a filled order — harmless after partial sells
      ].includes(code)) return;
      // 200 = no security definition — symbol is unresolvable (warrant, OTC, etc.)
      if ((code as unknown as number) === 200) {
        const sym = this.scanner.dropByReqId(reqId);
        if (sym) logger.warn('scanner', `${sym} removed — IBKR cannot resolve contract (error 200)`);
        return;
      }
      // 201 = order rejected by IBKR (e.g. insufficient margin, invalid price)
      // 202 = order cancelled — both mean the entry failed; clean up pending position
      if ((code as unknown as number) === 201 || (code as unknown as number) === 202) {
        const sym = this.execution.handleOrderCancelled(reqId as number);
        if (sym) {
          logger.warn('execution', `${sym} entry order cancelled by IBKR (${code}) — ${errMsg || 'no reason given'} — resetting to watching`);
          this.scanner.setStrategy(sym, 'watching');
          this.setState(this.execution.getOpenPositions().filter((p) => p.status === 'open').length > 0 ? 'monitoring' : 'scanning');
        }
        return;
      }
      logger.error('system', `IBKR error code ${code} (reqId ${reqId})${errMsg ? ` — ${errMsg}` : ''}`);
    });
  }

  /**
   * Connects to IBKR and starts background services (position sync, P&L
   * stream, market-status broadcast, the schedule loop). Safe to call once
   * at process boot — idempotent. Does NOT start the scanner/screener or
   * enable new entries; that's gated by the schedule (see evaluateSchedule).
   */
  async connectInfra() {
    if (this.infraReady) return;
    this.infraReady = true;

    logger.info('system', '🚀 AlphaAgent connecting to IBKR…');

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

    // Load today's fill history + start live P&L stream
    await this.execution.syncExecutions();
    this.execution.startPnLStream();
    this.execution.onExecutionsUpdate = () => this.emit('executions', this.execution.getExecutions());
    this.execution.onPnLUpdate = (pnl) => this.emit('pnl', pnl);

    // Subscribe live price ticks for every open position; re-emit on each update
    this.execution.startLiveTracking(() => this.emitPositions());

    this.scanner.on('alert', (alert: ScannerAlert) => this.handleAlert(alert));
    this.scanner.on('watchlist', (entries) => this.emit('watchlist', entries));

    // Emit market status every minute
    const status = getMarketStatus();
    this.emit('marketStatus', status);
    setInterval(() => this.emit('marketStatus', getMarketStatus()), 60_000);

    this.syncInterval = setInterval(() => this.syncAndEmit(), 5000);
    setInterval(() => this.manageOpenPositions(), 5000);

    this.setState(this.execution.getOpenPositions().filter((p) => p.status === 'open').length > 0 ? 'monitoring' : 'idle');
    logger.success('system', '✅ Connected to IBKR — open positions are being monitored.');

    // Schedule loop decides when to start/stop the trading session
    this.scheduleInterval = setInterval(() => this.evaluateSchedule(), 30_000);
    this.evaluateSchedule();
  }

  /**
   * Starts the scanner/screener and enables new entries. Called by the
   * schedule loop within 10 min of market open, or immediately by a manual
   * "Start" from the UI.
   */
  private startTrading() {
    if (this.tradingActive) return;
    this.tradingActive = true;
    // scanner.start() also starts the screener and wires the symbol stream internally
    this.scanner.start();
    this.setState(this.execution.getOpenPositions().filter((p) => p.status === 'open').length > 0 ? 'monitoring' : 'scanning');
    logger.success('system', '▶️  Trading session started — scanning for entries.');
  }

  /** Stops the scanner/screener (no new entries). Open positions keep being monitored. */
  private stopTrading(reason: string) {
    if (!this.tradingActive) return;
    this.tradingActive = false;
    this.scanner.stop();
    const hasOpenPositions = this.execution.getOpenPositions().filter((p) => p.status === 'open').length > 0;
    this.setState(hasOpenPositions ? 'monitoring' : 'idle');
    logger.warn('system', `⏸️  Trading session stopped — ${reason}.`);
  }

  /**
   * Runs every 30 s. Starts the trading session within 10 min of market
   * open and keeps it running while the market is open and there's enough
   * cash to open a new position; otherwise stops it (existing positions
   * are still managed regardless).
   */
  /**
   * Runs every 30 s. Starts the trading session within 10 min of market
   * open. Once running, it stays running through after-hours/closed —
   * the scanner keeps watching and the market-hours gate in _handleAlert
   * already skips research/entries while the market is closed. The only
   * thing that stops a running session is running out of available cash.
   */
  private evaluateSchedule() {
    if (this.manuallyPaused) return;

    const status = getMarketStatus();
    const mins = minutesUntilOpen();
    const withinStartWindow = status === 'open' || (mins >= 0 && mins <= 10);

    const availableCash = this.execution.getAvailableCash();
    // Treat 0/unknown as "ok" — don't block startup before the first cash sync
    const hasCash = availableCash <= 0 || availableCash >= this.minAvailableCash;

    if (withinStartWindow && hasCash) {
      this.startTrading();
    } else if (this.tradingActive && !hasCash) {
      // Keep scanner running while any position is still open — price ticks are
      // needed for position management. Only stop once all positions are closed.
      const hasOpenPositions = this.execution.getOpenPositions().some((p) => p.status === 'open');
      if (!hasOpenPositions) {
        this.stopTrading(`available cash $${availableCash.toFixed(0)} too low to open new positions`);
      }
    }
  }

  /** Manual start from the UI — connects infra if needed and starts trading immediately. */
  async start() {
    this.manuallyPaused = false;
    if (!this.infraReady) await this.connectInfra();
    this.startTrading();
  }

  pause() {
    this.manuallyPaused = true;
    this.stopTrading('manually paused');
    this.setState('paused');
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

    // ── Deduplicate: skip if this symbol is already in the pipeline ──────────
    if (this.inPipeline.has(alert.symbol)) return;
    // Also skip if we already have a pending/open position for this symbol
    const existingPos = this.execution.getOpenPositions().find((p) => p.symbol === alert.symbol);
    if (existingPos) return;
    this.inPipeline.add(alert.symbol);

    try {
      await this._handleAlert(alert);
    } finally {
      this.inPipeline.delete(alert.symbol);
    }
  }

  private async _handleAlert(alert: ScannerAlert) {
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

    // ── Adaptive strategy: thresholds scale with available cash ─────────────
    const adaptive = this.adaptiveStrategy();
    const openCount = this.execution.getOpenPositions().length;

    // Block new entries if at the adaptive position limit
    if (openCount >= adaptive.maxPositions) {
      logger.info('system', `${alert.symbol} skipped — ${openCount}/${adaptive.maxPositions} positions open (${adaptive.logReason})`);
      return;
    }

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

    if (catalyst.score < adaptive.minScore) {
      logger.warn('system', `${alert.symbol} skipped — score ${catalyst.score}/100 below adaptive threshold (${adaptive.minScore}). ${adaptive.logReason}`);
      this.scanner.setStrategy(alert.symbol, 'rejected');
      this.setState('scanning');
      return;
    }

    this.setState('executing');
    this.scanner.setStrategy(alert.symbol, 'sizing');
    // Research can take several seconds — re-anchor to the freshest live IBKR tick so the
    // bracket's limit/SL/TP aren't built off a stale alert snapshot (causes IBKR to auto-cancel
    // the order as "price out of range", as seen repeatedly with fast-moving NPT).
    const freshPrice = this.scanner.getLastPrice(alert.symbol) ?? alert.price;
    if (Math.abs(freshPrice - alert.price) / alert.price > 0.02) {
      logger.info('execution', `${alert.symbol} price moved since alert: $${alert.price.toFixed(2)} → $${freshPrice.toFixed(2)} — re-anchoring entry`);
    }
    // Pass adaptive position size % to risk engine for this trade
    const sizing = this.risk.size(alert.symbol, freshPrice, catalyst, openCount, alert, adaptive.positionSizePct);
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

        // Re-anchor stop-loss to actual fill price — the bracket was sized on the
        // alert price which may differ significantly after a chase or fast move
        const s = settingsStore.get();
        const anchoredStop = parseFloat((fillPrice * (1 - s.stopLossPct / 100)).toFixed(2));
        const adjusted = this.execution.adjustStop(symbol, anchoredStop);
        if (adjusted) {
          logger.trade('system', `🔒 ${symbol} SL anchored to fill: $${anchoredStop.toFixed(2)} (${s.stopLossPct}% below $${fillPrice.toFixed(2)})`);
        }

        // No TP limit order is ever submitted at the broker — the 5%-ladder in
        // manageOpenPositions watches live price vs session high every 5 s and
        // sells when momentum actually stalls, letting strong moves run further.
        this.scanner.setStrategy(symbol, 'positioned');
        this.emitPositions();
        this.setState('monitoring');
      };

      // Faster timers for fast-moving alerts — a stock surging 5%+/min outruns a slow chase
      const fastMover = Math.abs(alert.priceChangePct) >= 5;
      const chaseDelayMs  = fastMover ? 15_000 : 30_000;
      const cancelDelayMs = fastMover ? 35_000 : 60_000;
      // Bump scales with momentum: at least 1.5%, more for fast movers (half their 1-min move)
      // Chase bump: scale to momentum but hard-cap at 5% — a +200% pre-market
      // surge should not produce a +110% chase that re-prices the whole bracket
      const chaseBumpPct = Math.min(0.05, Math.max(0.015, Math.abs(alert.priceChangePct) / 100 / 2));

      // Chase unfilled entry — bump limit price toward market, scaled to momentum
      chaseTimer = setTimeout(() => {
        const stillPending = this.execution.getOpenPositions()
          .find((p) => p.symbol === alert.symbol && p.status === 'pending');
        if (!stillPending) return;
        const newLimit = parseFloat((sizing.entryPrice * (1 + chaseBumpPct)).toFixed(2));
        logger.warn('execution', `${alert.symbol} entry not filled after ${chaseDelayMs / 1000}s — chasing @ $${newLimit} (+${(chaseBumpPct * 100).toFixed(1)}%)`);
        this.execution.chaseEntryOrder(alert.symbol, newLimit);
      }, chaseDelayMs);

      // Give up — cancel the whole bracket and reset
      cancelTimer = setTimeout(() => {
        const stillPending = this.execution.getOpenPositions()
          .find((p) => p.symbol === alert.symbol && p.status === 'pending');
        if (!stillPending) return;
        logger.warn('execution', `${alert.symbol} entry not filled after ${cancelDelayMs / 1000}s — cancelling`);
        this.execution.cancelPendingEntry(alert.symbol);
        this.scanner.setStrategy(alert.symbol, 'watching');
        this.setState(this.execution.getOpenPositions().filter((p) => p.status === 'open').length > 0 ? 'monitoring' : 'scanning');
      }, cancelDelayMs);
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

    const ibPnL = this.execution.getAccountPnL();
    // Prefer IBKR's own P&L numbers when available (more accurate than calculated)
    const realizedPnl  = ibPnL?.realizedPnL   ?? 0;
    const unrealPnl    = ibPnL?.unrealizedPnL  ?? dailyUnrealized;
    const dailyPnl     = ibPnL?.dailyPnL       ?? (realizedPnl + unrealPnl);
    const dailyPnlPct  = this.startingLiquidity > 0
      ? (dailyPnl / this.startingLiquidity) * 100
      : 0;

    const snapshot: PortfolioSnapshot = {
      netLiquidity: liquidity,
      availableCash: this.execution.getAvailableCash(),
      dailyRealizedPnl: realizedPnl,
      dailyUnrealizedPnl: unrealPnl,
      dailyPnlPct,
      openPositions,
      activeRiskMultiplier: this.risk.activeRiskMultiplier,
      snapshotAt: Date.now(),
      ibkrPnL: ibPnL ?? undefined,
    };

    this.performanceHistory.push({ timestamp: Date.now(), equity: liquidity, pnl: dailyPnlPct });
    if (this.performanceHistory.length > 390) this.performanceHistory.shift();

    this.emit('portfolio', snapshot);
    this.emit('performance', this.performanceHistory);
    this.emitPositions();
  }

  emitPositions() {
    this.emit('positions', this.execution.getOpenPositions());
    this.emit('orders', this.execution.getOpenOrders());
    this.emit('executions', this.execution.getExecutions());
  }

  getExecutions(): TradeExecution[] { return this.execution.getExecutions(); }

  /**
   * Active position management — runs every 5 s.
   *
   * For each open position:
   *   1. Track session high
   *   2. Profit ladder: every 5% gain starting at +10%, re-check vs session
   *      high — if stalling (pulled back ≥3% from high), sell half;
   *      otherwise hold and let it run
   *   3. Reversal exit: up > half-stop% and pulls back 6%+ from high before
   *      any ladder tier has been hit
   *
   * The stop-loss order placed at entry is never modified — it stays at
   * its initial price for the life of the position.
   */
  private manageOpenPositions() {
    const s = settingsStore.get();
    const positions = this.execution.getOpenPositions().filter((p) => p.status === 'open');
    if (positions.length === 0) return;

    // ── End-of-day forced close: market-close positions ≤ 5 min before 4:00 PM ET ─
    const minsLeft = minutesUntilClose();
    if (minsLeft >= 0 && minsLeft <= 5) {
      logger.warn('system', `🔔 Market closes in ${minsLeft} min — force-closing all ${positions.length} position(s)`);
      for (const pos of positions) {
        this.execution.closePosition(pos.symbol);
        this.scanner.setStrategy(pos.symbol, 'watching');
      }
      this.setState('idle');
      this.emitPositions();
      return;
    }

    let changed = false;

    for (const pos of positions) {
      const price = pos.currentPrice;
      if (price <= 0 || pos.avgPrice <= 0) continue;

      const pctFromEntry = ((price - pos.avgPrice) / pos.avgPrice) * 100;

      // Track session high
      if (!pos.sessionHigh || price > pos.sessionHigh) {
        pos.sessionHigh = price;
      }

      const pctFromHigh = pos.sessionHigh > 0
        ? ((price - pos.sessionHigh) / pos.sessionHigh) * 100
        : 0;

      // ── Profit ladder: every 5% from +10%, sell-half-if-stalling or hold ─────
      // Re-evaluated every 5s against the session high. Does NOT touch the
      // stop-loss order — that stays at its initial entry-time price.
      const TIER_STEP = 5;
      const FIRST_TIER = 10;
      if (pctFromEntry >= FIRST_TIER) {
        const tier = Math.floor((pctFromEntry - FIRST_TIER) / TIER_STEP) * TIER_STEP + FIRST_TIER;
        const lastTier = pos.lastTierHit ?? 0;
        if (tier > lastTier) {
          pos.lastTierHit = tier;
          const stalling = pctFromHigh <= -3; // pulled back ≥3% from session high

          if (stalling && pos.shares > 1) {
            const sellQty = Math.max(1, Math.floor(pos.shares / 2));
            this.execution.partialSell(pos.symbol, sellQty, `+${tier}% tier, stalling (${pctFromHigh.toFixed(1)}% off high) — locking gains`);
            logger.trade('system', `📈 ${pos.symbol} +${tier}% tier — stalling, sold ${sellQty} sh`);
          } else {
            logger.trade('system', `↗ ${pos.symbol} +${tier}% tier — still running, holding`);
          }
          changed = true;
        }
      }

      // ── Reversal exit: profitable position pulls back hard before any tier ──
      const breakEvenTriggerPct = s.stopLossPct / 2;
      if (
        pos.sessionHigh &&
        pctFromEntry > breakEvenTriggerPct &&
        pctFromHigh < -6 &&
        !(pos.lastTierHit)
      ) {
        logger.trade('system', `⚠️  ${pos.symbol} reversal — up ${pctFromEntry.toFixed(1)}% but -${Math.abs(pctFromHigh).toFixed(1)}% from high. Exiting.`);
        this.execution.closePosition(pos.symbol);
        this.scanner.setStrategy(pos.symbol, 'watching');
        changed = true;
      }
    }

    if (changed) this.emitPositions();
  }

  /**
   * Adaptive strategy — adjusts thresholds based on available cash.
   *
   * With very little cash: concentrate into ONE high-conviction trade,
   * demand higher catalyst score, deploy most of the cash in one go.
   *
   * With more cash: spread across multiple positions to reduce risk,
   * accept lower catalyst scores since losing one trade doesn't hurt as much.
   *
   * Returns effective overrides that take precedence over settings-store values.
   */
  private adaptiveStrategy(): { maxPositions: number; minScore: number; positionSizePct: number; logReason: string } {
    const cash = this.execution.getAvailableCash();
    const s = settingsStore.get();

    if (cash < 150) {
      return {
        maxPositions: 1,
        minScore: Math.max(s.minCatalystScore, 40),
        positionSizePct: 90,
        logReason: `low cash $${cash.toFixed(0)} — 1 high-conviction trade only, score ≥ 40`,
      };
    }
    if (cash < 400) {
      return {
        maxPositions: 1,
        minScore: Math.max(s.minCatalystScore, 30),
        positionSizePct: 80,
        logReason: `limited cash $${cash.toFixed(0)} — 1 trade, score ≥ 30`,
      };
    }
    if (cash < 1000) {
      return {
        maxPositions: Math.min(s.maxOpenPositions, 2),
        minScore: Math.max(s.minCatalystScore, 30),
        positionSizePct: 60,
        logReason: `moderate cash $${cash.toFixed(0)} — up to 2 trades, score ≥ 30`,
      };
    }
    if (cash < 3000) {
      return {
        maxPositions: Math.min(s.maxOpenPositions, 3),
        minScore: s.minCatalystScore,
        positionSizePct: 40,
        logReason: `good cash $${cash.toFixed(0)} — up to 3 trades`,
      };
    }
    return {
      maxPositions: s.maxOpenPositions,
      minScore: s.minCatalystScore,
      positionSizePct: Math.min(s.maxPositionSizePct, 30),
      logReason: `ample cash $${cash.toFixed(0)} — full diversification`,
    };
  }

  private setState(state: AgentState) {
    this.state = state;
    this.emit('state', state);
  }

  getState(): AgentState { return this.state; }
  getPerformanceHistory(): PerformanceDataPoint[] { return [...this.performanceHistory]; }
}
