import EventEmitter from 'events';
import {
  IBApi,
  EventName,
  Contract,
  SecType,
} from '@stoqey/ib';
import { logger } from '../utils/logger';
import { settingsStore } from './settings';
import type { ScannerAlert, WatchlistEntry, SymbolStrategy } from '../types';

interface TickState {
  prices: { price: number; ts: number }[];
  volumes: number[];
  avgVolume: number;
  float: number;
  lastPrice: number;
  openPrice: number;   // first tick of the session — used for % change
  strategy: SymbolStrategy;
  // Breakout tracking
  recentHigh: number;       // highest price in the last 5 min
  recentHighTs: number;
  consolidationStart: number | null;  // ts when tight range began
  consolidationBase: number;          // price floor of the consolidation
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
  private tickState = new Map<string, TickState>();
  private symbolToReqId = new Map<string, number>();
  private reqIdToSymbol = new Map<number, string>();
  private alertCooldown = new Map<string, number>();
  private symbolLastSeen = new Map<string, number>();   // ts of last Polygon mention
  private nextReqId = 100;
  private running = false;
  private watchlistThrottle: NodeJS.Timeout | null = null;

  constructor(ib: IBApi) {
    super();
    this.ib = ib;
  }

  start() {
    if (this.running) return;
    this.running = true;
    // 4 = real-time if subscribed, delayed otherwise — suppresses error 10089
    this.ib.reqMarketDataType(4);
    this.attachTickHandlers();
    logger.info('scanner', 'Scanner ready — waiting for first screener batch…');
  }

  stop() {
    this.running = false;
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
      } else if (float) {
        // Update float if screener provided a value
        const state = this.tickState.get(symbol);
        if (state) state.float = float;
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
    this.ib.on(EventName.tickPrice, (reqId: number, tickType: number, price: number) => {
      const symbol = this.reqIdToSymbol.get(reqId);
      if (!symbol || price <= 0) return;
      if (tickType === 4) this.onLastPrice(symbol, price);
    });

    (this.ib as unknown as { on: (e: string, h: (...a: unknown[]) => void) => void })
      .on('tickSize', (reqId: unknown, tickType: unknown, size: unknown) => {
        const symbol = this.reqIdToSymbol.get(reqId as number);
        if (!symbol) return;
        if (tickType === 8) this.onVolume(symbol, Number(size));
      });
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
    const s = settingsStore.get();
    const state = this.tickState.get(symbol);
    if (!state || state.prices.length < 2) return;
    if (price < s.minPrice || price > s.maxPrice) return;

    const currentVol = state.volumes[state.volumes.length - 1] ?? 0;
    const relVol = state.avgVolume > 0 ? currentVol / state.avgVolume : 0;

    // ── Update 5-min rolling high ─────────────────────────────────────────────
    const fiveMinAgo = ts - 5 * 60_000;
    if (price > state.recentHigh || state.recentHighTs < fiveMinAgo) {
      // Recalculate high from recent price history
      const recentPrices = state.prices.filter((p) => p.ts >= fiveMinAgo);
      state.recentHigh = recentPrices.length > 0
        ? Math.max(...recentPrices.map((p) => p.price))
        : price;
      state.recentHighTs = ts;
    }

    // ── Consolidation detection ───────────────────────────────────────────────
    // A 2-min window where price range is < 1.5% = consolidation / base building
    const twoMinAgo = ts - 2 * 60_000;
    const recentWindow = state.prices.filter((p) => p.ts >= twoMinAgo);
    if (recentWindow.length >= 3) {
      const winHigh = Math.max(...recentWindow.map((p) => p.price));
      const winLow  = Math.min(...recentWindow.map((p) => p.price));
      const winRange = (winHigh - winLow) / winLow * 100;

      if (winRange < 1.5) {
        // Price is consolidating — track it
        if (!state.consolidationStart) {
          state.consolidationStart = twoMinAgo;
          state.consolidationBase  = winLow;
        }
      } else {
        // Range expanded — reset consolidation if price dropped away
        if (price < state.consolidationBase * 0.99) {
          state.consolidationStart = null;
          state.consolidationBase = price;
        }
      }
    }

    // ── Surge calculations ────────────────────────────────────────────────────
    const oneMinAgo = ts - 60_000;
    const pastTick = state.prices.findLast((p) => p.ts <= oneMinAgo);
    const tickSurgePct = pastTick ? ((price - pastTick.price) / pastTick.price) * 100 : 0;

    const sessionSurgePct = state.openPrice > 0
      ? ((price - state.openPrice) / state.openPrice) * 100
      : 0;

    const surgePct = Math.max(tickSurgePct, sessionSurgePct);

    if (state.float >= s.maxFloatM) return;

    const rvolOk = state.volumes.length < 10 ? true : relVol >= s.minRelativeVolume;

    // ── Breakout detection ────────────────────────────────────────────────────
    // Trigger if: price breaks above 5-min high by >0.5% with volume, OR normal surge gate passes
    const prevHigh = state.recentHigh;
    const isBreakout = prevHigh > 0 && price > prevHigh * 1.005 && rvolOk;
    const hadConsolidation = state.consolidationStart !== null &&
      (ts - state.consolidationStart) >= 60_000;  // consolidation lasted ≥ 1 min

    const surgeOk = surgePct >= s.minPriceSurgePct && rvolOk;

    if (!surgeOk && !isBreakout) return;

    const lastAlert = this.alertCooldown.get(symbol) ?? 0;
    if (ts - lastAlert < 5 * 60_000) return;
    this.alertCooldown.set(symbol, ts);

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

    const alert: ScannerAlert = {
      symbol, price, priceChangePct: surgePct, volume: currentVol,
      relativeVolume: relVol, float: state.float,
      marketCap: price * state.float * 1_000_000,
      timestamp: ts, triggerReasons,
    };

    logger.success('scanner', `🚨 ALERT: ${symbol} @ $${price.toFixed(2)} — ${triggerReasons.join(' | ')}`, { alert });
    this.emit('alert', alert);
  }
}
