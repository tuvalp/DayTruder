import EventEmitter from 'events';
import {
  IBApi,
  EventName,
  Contract,
  SecType,
} from '@stoqey/ib';
import { logger } from '../utils/logger';
import { settingsStore } from './settings';
import type { PolygonScreener, ScreenerResult } from './screener';
import type { ScannerAlert, WatchlistEntry, SymbolStrategy } from '../types';

interface TickState {
  prices: { price: number; ts: number }[];
  volumes: number[];
  avgVolume: number;
  float: number;
  lastPrice: number;
  openPrice: number;
  strategy: SymbolStrategy;
  // Breakout tracking
  recentHigh: number;
  recentHighTs: number;
  consolidationStart: number | null;
  consolidationBase: number;
  // Throttle evaluate() to every 5 s
  lastEvaluateTs: number;
}

/**
 * Real-Time Market Scanner — IBKR
 *
 * Starts with an empty watchlist. The Polygon screener calls
 * ingestSymbols() every 30 s with that session's actual movers.
 * Each new symbol gets a reqMktData subscription; stale symbols
 * (not seen in the last 2 Polygon polls) are unsubscribed automatically.
 */
export class MarketScanner extends EventEmitter {
  private ib: IBApi;
  private screener: PolygonScreener;
  private tickState = new Map<string, TickState>();
  private symbolToReqId = new Map<string, number>();
  private reqIdToSymbol = new Map<number, string>();
  private alertCooldown = new Map<string, number>();
  private symbolLastSeen = new Map<string, number>();
  private nextReqId = 100;
  private running = false;
  private watchlistThrottle: NodeJS.Timeout | null = null;

  constructor(ib: IBApi, screener: PolygonScreener) {
    super();
    this.ib = ib;
    this.screener = screener;
  }

  start() {
    if (this.running) return;
    this.running = true;
    // 4 = real-time if subscribed, delayed otherwise — suppresses error 10089
    this.ib.reqMarketDataType(4);
    this.attachTickHandlers();

    // Wire screener stream directly into scanner — no agent callback needed
    this.screener.on('symbols', (results: ScreenerResult[]) => {
      this.ingestSymbols(results.map((r) => ({ symbol: r.symbol, float: r.float, price: r.price })));
    });
    this.screener.start();

    logger.info('scanner', 'Scanner ready — wired to screener stream');
  }

  stop() {
    this.running = false;
    this.screener.stop();
    this.screener.removeAllListeners('symbols');
    for (const reqId of this.symbolToReqId.values()) {
      try { this.ib.cancelMktData(reqId); } catch { /* ignore */ }
    }
    this.symbolToReqId.clear();
    this.reqIdToSymbol.clear();
    this.tickState.clear();
    logger.info('scanner', 'All market data subscriptions cancelled.');
  }

  /**
   * Called by PolygonScreener with the current session's movers.
   * Subscribes to new symbols and unsubscribes symbols that have
   * dropped off the screener for more than 2 consecutive polls.
   */
  ingestSymbols(symbols: { symbol: string; float?: number; price?: number }[]) {
    const now = Date.now();

    // Mark each incoming symbol as seen
    for (const { symbol, float, price } of symbols) {
      this.symbolLastSeen.set(symbol, now);
      if (!this.symbolToReqId.has(symbol)) {
        this.subscribe(symbol, float, price);
      } else {
        // Symbol already subscribed — feed fresh screener price as a tick so
        // evaluate() runs every 30 s regardless of IBKR delayed-data frequency
        const state = this.tickState.get(symbol);
        if (state) {
          if (float) state.float = float;
          if (price && price > 0) this.onLastPrice(symbol, price);
        }
      }
    }

    // Unsubscribe symbols not seen in the last 2 poll intervals (2 × 30 s = 60 s)
    const staleThreshold = now - 65_000;
    for (const [symbol, lastSeen] of this.symbolLastSeen.entries()) {
      if (lastSeen < staleThreshold && this.symbolToReqId.has(symbol)) {
        this.unsubscribe(symbol);
      }
    }

    logger.info(
      'scanner',
      `Watchlist: ${this.symbolToReqId.size} active symbols | +${symbols.length} from screener`
    );
    this.emitWatchlist();
  }

  /** Called by the agent when IBKR returns error 200 for a reqId — drop that symbol. */
  dropByReqId(reqId: number): string | null {
    const symbol = this.reqIdToSymbol.get(reqId);
    if (!symbol) return null;
    this.unsubscribe(symbol);
    return symbol;
  }

  /** Called by the agent to update the pipeline stage for a symbol. */
  setStrategy(symbol: string, strategy: SymbolStrategy) {
    const state = this.tickState.get(symbol);
    if (state) { state.strategy = strategy; this._doEmitWatchlist(); }
  }

  private emitWatchlist() {
    // Throttle: emit at most once per second to avoid flooding the socket
    if (this.watchlistThrottle) return;
    this.watchlistThrottle = setTimeout(() => {
      this.watchlistThrottle = null;
      this._doEmitWatchlist();
    }, 1000);
  }

  private _doEmitWatchlist() {
    const entries: WatchlistEntry[] = [];
    for (const [symbol, state] of this.tickState.entries()) {
      if (state.lastPrice === 0) continue;
      const changePct = state.openPrice > 0
        ? ((state.lastPrice - state.openPrice) / state.openPrice) * 100
        : 0;
      const currentVol = state.volumes[state.volumes.length - 1] ?? 0;
      const relVol = state.avgVolume > 0 ? currentVol / state.avgVolume : 0;
      entries.push({
        symbol,
        price: state.lastPrice,
        changePercent: changePct,
        relVol,
        strategy: state.strategy,
        updatedAt: Date.now(),
      });
    }
    // Sort: positioned first, then by % change descending
    entries.sort((a, b) => {
      if (a.strategy === 'positioned' && b.strategy !== 'positioned') return -1;
      if (b.strategy === 'positioned' && a.strategy !== 'positioned') return 1;
      return b.changePercent - a.changePercent;
    });
    this.emit('watchlist', entries);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private subscribe(symbol: string, float?: number, seedPrice?: number) {
    const reqId = this.nextReqId++;
    this.symbolToReqId.set(symbol, reqId);
    this.reqIdToSymbol.set(reqId, symbol);
    this.tickState.set(symbol, {
      prices: [],
      volumes: [],
      avgVolume: 0,
      float: float ?? 15,
      lastPrice: seedPrice ?? 0,
      openPrice: seedPrice ?? 0,
      strategy: 'watching',
      recentHigh: seedPrice ?? 0,
      recentHighTs: Date.now(),
      consolidationStart: null,
      consolidationBase: seedPrice ?? 0,
      lastEvaluateTs: 0,
    });

    const contract: Contract = {
      symbol,
      secType: SecType.STK,
      currency: 'USD',
      exchange: 'SMART',
    };

    (this.ib as unknown as { reqMktData: (...a: unknown[]) => void }).reqMktData(reqId, contract, '236', false, false, []);
  }

  private unsubscribe(symbol: string) {
    const reqId = this.symbolToReqId.get(symbol);
    if (reqId === undefined) return;
    try { this.ib.cancelMktData(reqId); } catch { /* ignore */ }
    this.symbolToReqId.delete(symbol);
    this.reqIdToSymbol.delete(reqId);
    this.tickState.delete(symbol);
    this.symbolLastSeen.delete(symbol);
  }

  private attachTickHandlers() {
    // tickType 4 = real-time last, 68 = delayed last (reqMarketDataType 3/4)
    this.ib.on(EventName.tickPrice, (reqId: number, tickType: number, price: number) => {
      const symbol = this.reqIdToSymbol.get(reqId);
      if (!symbol || price <= 0) return;
      if (tickType === 4 || tickType === 68) this.onLastPrice(symbol, price);
    });

    // tickType 8 = real-time volume, 74 = delayed volume
    (this.ib as unknown as { on: (e: string, h: (...a: unknown[]) => void) => void })
      .on('tickSize', (reqId: unknown, tickType: unknown, size: unknown) => {
        const symbol = this.reqIdToSymbol.get(reqId as number);
        if (!symbol) return;
        if (tickType === 8 || tickType === 74) this.onVolume(symbol, Number(size));
      });
  }

  /** Freshest live IBKR tick price for a symbol — more current than the alert's snapshot price. */
  getLastPrice(symbol: string): number | undefined {
    const state = this.tickState.get(symbol);
    return state && state.lastPrice > 0 ? state.lastPrice : undefined;
  }

  private onLastPrice(symbol: string, price: number) {
    const state = this.tickState.get(symbol);
    if (!state) return;
    if (state.openPrice === 0) state.openPrice = price;
    state.lastPrice = price;
    const ts = Date.now();
    state.prices.push({ price, ts });
    if (state.prices.length > 120) state.prices.shift();
    this.evaluate(symbol, price, ts);
    this.emitWatchlist();
  }

  private onVolume(symbol: string, volume: number) {
    const state = this.tickState.get(symbol);
    if (!state) return;
    state.volumes.push(volume);
    if (state.volumes.length > 200) state.volumes.shift();
    const slice = state.volumes.slice(0, -1);
    state.avgVolume = slice.length
      ? slice.reduce((a, b) => a + b, 0) / slice.length
      : 0;
  }

  private evaluate(symbol: string, price: number, ts: number) {
    const state = this.tickState.get(symbol);
    if (!state || state.prices.length < 2) return;

    // ── 5-second evaluation gate ──────────────────────────────────────────────
    if (ts - state.lastEvaluateTs < 5_000) return;
    state.lastEvaluateTs = ts;

    const s = settingsStore.get();
    if (price < s.minPrice || price > s.maxPrice) return;
    if (state.float >= s.maxFloatM) return;

    const currentVol = state.volumes[state.volumes.length - 1] ?? 0;
    const relVol = state.avgVolume > 0 ? currentVol / state.avgVolume : 0;
    const rvolOk = state.volumes.length < 10 ? true : relVol >= s.minRelativeVolume;

    // ── Support / resistance from recent price history ────────────────────────
    const fiveMinAgo  = ts - 5 * 60_000;
    const twoMinAgo   = ts - 2 * 60_000;
    const recentPrices = state.prices.filter((p) => p.ts >= fiveMinAgo);
    const recentWindow = state.prices.filter((p) => p.ts >= twoMinAgo);

    const resistance = recentPrices.length > 0
      ? Math.max(...recentPrices.map((p) => p.price))
      : price;

    const support = recentPrices.length > 0
      ? Math.min(...recentPrices.map((p) => p.price))
      : price;

    // ── Update rolling high ───────────────────────────────────────────────────
    if (price > state.recentHigh || state.recentHighTs < fiveMinAgo) {
      state.recentHigh  = resistance;
      state.recentHighTs = ts;
    }

    // ── Consolidation detection ───────────────────────────────────────────────
    if (recentWindow.length >= 3) {
      const winHigh  = Math.max(...recentWindow.map((p) => p.price));
      const winLow   = Math.min(...recentWindow.map((p) => p.price));
      const winRange = (winHigh - winLow) / winLow * 100;

      if (winRange < 1.5) {
        if (!state.consolidationStart) {
          state.consolidationStart = twoMinAgo;
          state.consolidationBase  = winLow;
        }
      } else if (price < state.consolidationBase * 0.99) {
        state.consolidationStart = null;
        state.consolidationBase  = price;
      }
    }

    // ── Surge calculations ────────────────────────────────────────────────────
    const oneMinAgo = ts - 60_000;
    const pastTick = state.prices.findLast((p) => p.ts <= oneMinAgo);
    const tickSurgePct    = pastTick ? ((price - pastTick.price) / pastTick.price) * 100 : 0;
    const sessionSurgePct = state.openPrice > 0
      ? ((price - state.openPrice) / state.openPrice) * 100 : 0;
    const surgePct = Math.max(tickSurgePct, sessionSurgePct);

    // ── Breakout gate ─────────────────────────────────────────────────────────
    const prevHigh        = state.recentHigh;
    const isBreakout      = prevHigh > 0 && price > prevHigh * 1.005 && rvolOk;
    const hadConsolidation = state.consolidationStart !== null &&
      (ts - state.consolidationStart) >= 60_000;
    const surgeOk = surgePct >= s.minPriceSurgePct && rvolOk;

    if (!surgeOk && !isBreakout) return;

    const lastAlert = this.alertCooldown.get(symbol) ?? 0;
    if (ts - lastAlert < 2 * 60_000) return;
    this.alertCooldown.set(symbol, ts);

    // ── Best entry / exit suggestion ──────────────────────────────────────────
    // Entry: pull back to support or consolidation base (don't chase the spike)
    // Exit:  previous resistance or +minTakeProfitPct above entry
    const suggestedEntry = state.consolidationStart
      ? Math.max(state.consolidationBase, support)
      : parseFloat((price * 0.99).toFixed(2));  // 1% pullback target if no base

    const suggestedExit = parseFloat(
      Math.max(resistance * 1.005, price * (1 + s.minTakeProfitPct / 100)).toFixed(2)
    );

    const triggerReasons: string[] = [];
    if (isBreakout && hadConsolidation) {
      triggerReasons.push(`Breakout above $${prevHigh.toFixed(2)} after consolidation`);
    } else if (isBreakout) {
      triggerReasons.push(`Breakout above 5-min high $${prevHigh.toFixed(2)}`);
    }
    if (surgePct >= s.minPriceSurgePct) {
      triggerReasons.push(tickSurgePct >= s.minPriceSurgePct
        ? `+${tickSurgePct.toFixed(2)}% in 1 min`
        : `+${sessionSurgePct.toFixed(2)}% today`);
    }
    triggerReasons.push(relVol > 0 ? `RVOL ${relVol.toFixed(1)}×` : 'Volume active');
    triggerReasons.push(`Float ${state.float.toFixed(1)}M`);
    triggerReasons.push(`Entry ~$${suggestedEntry.toFixed(2)} → Exit ~$${suggestedExit.toFixed(2)}`);

    const alert: ScannerAlert = {
      symbol, price, priceChangePct: surgePct, volume: currentVol,
      relativeVolume: relVol, float: state.float,
      marketCap: price * state.float * 1_000_000,
      timestamp: ts, triggerReasons,
      suggestedEntry,
      suggestedExit,
      supportLevel:    parseFloat(support.toFixed(2)),
      resistanceLevel: parseFloat(resistance.toFixed(2)),
    };

    logger.success('scanner', `🚨 ALERT: ${symbol} @ $${price.toFixed(2)} — ${triggerReasons.join(' | ')}`, { alert });
    this.emit('alert', alert);
  }
}
