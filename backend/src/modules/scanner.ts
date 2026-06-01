import EventEmitter from 'events';
import {
  IBApi,
  EventName,
  Contract,
  SecType,
  Currency,
} from '@stoqey/ib';
import { logger } from '../utils/logger';
import { settingsStore } from './settings';
import type { ScannerAlert } from '../types';

interface TickState {
  prices: { price: number; ts: number }[];
  volumes: number[];
  avgVolume: number;
  float: number;
  lastPrice: number;
}

/**
 * Real-Time Market Scanner — IBKR (watchlist-based)
 *
 * Subscribes to Level-1 market data (reqMktData) for a fixed watchlist of
 * known low-float micro-cap symbols. No scanner subscription or paid data
 * add-on is required — only the base IBKR live data feed.
 *
 * Evaluation criteria (all read live from settingsStore):
 *   • Price within [minPrice, maxPrice]
 *   • Float < maxFloatM million shares
 *   • Relative volume ≥ minRelativeVolume
 *   • 1-minute price surge ≥ minPriceSurgePct %
 */
export class MarketScanner extends EventEmitter {
  private ib: IBApi;
  private tickState = new Map<string, TickState>();
  private symbolToReqId = new Map<string, number>();
  private reqIdToSymbol = new Map<number, string>();
  private alertCooldown = new Map<string, number>();
  private nextReqId = 100;   // start above 0 to avoid collision with execution orders
  private running = false;
  private watchlist: string[] = DEFAULT_WATCHLIST;

  constructor(ib: IBApi) {
    super();
    this.ib = ib;
  }

  /** Replace the default watchlist before calling start(). */
  setWatchlist(symbols: string[]) {
    this.watchlist = symbols;
  }

  start() {
    if (this.running) return;
    this.running = true;
    logger.info('scanner', `Subscribing to ${this.watchlist.length} symbols via reqMktData…`);
    this.attachTickHandlers();
    for (const symbol of this.watchlist) this.subscribe(symbol);
    logger.success('scanner', 'Market data subscriptions active.');
  }

  stop() {
    this.running = false;
    for (const reqId of this.symbolToReqId.values()) {
      try { this.ib.cancelMktData(reqId); } catch { /* ignore */ }
    }
    this.symbolToReqId.clear();
    this.reqIdToSymbol.clear();
    logger.info('scanner', 'All market data subscriptions cancelled.');
  }

  addSymbol(symbol: string) {
    if (this.symbolToReqId.has(symbol)) return;
    this.watchlist.push(symbol);
    if (this.running) this.subscribe(symbol);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private subscribe(symbol: string) {
    const reqId = this.nextReqId++;
    this.symbolToReqId.set(symbol, reqId);
    this.reqIdToSymbol.set(reqId, symbol);
    this.tickState.set(symbol, {
      prices: [],
      volumes: [],
      avgVolume: 0,
      float: FLOAT_MAP[symbol] ?? 15,
      lastPrice: 0,
    });

    const contract: Contract = {
      symbol,
      secType: SecType.STK,
      currency: Currency.USD,
      exchange: 'SMART',
    };

    // Generic tick 236 = shortable shares (proxy for borrow / float squeeze)
    this.ib.reqMktData(reqId, contract, '236', false, false, []);
  }

  private attachTickHandlers() {
    this.ib.on(EventName.tickPrice, (reqId: number, tickType: number, price: number) => {
      const symbol = this.reqIdToSymbol.get(reqId);
      if (!symbol || price <= 0) return;
      if (tickType === 4) this.onLastPrice(symbol, price);  // 4 = Last
    });

    this.ib.on(EventName.tickSize, (reqId: number, tickType: number, size: number) => {
      const symbol = this.reqIdToSymbol.get(reqId);
      if (!symbol) return;
      if (tickType === 8) this.onVolume(symbol, Number(size));  // 8 = Volume
    });
  }

  private onLastPrice(symbol: string, price: number) {
    const state = this.tickState.get(symbol);
    if (!state) return;
    state.lastPrice = price;
    const ts = Date.now();
    state.prices.push({ price, ts });
    if (state.prices.length > 120) state.prices.shift();
    this.evaluate(symbol, price, ts);
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
    if (!state || state.prices.length < 5) return;
    if (price < s.minPrice || price > s.maxPrice) return;

    const currentVol = state.volumes[state.volumes.length - 1] ?? 0;
    const relVol = state.avgVolume > 0 ? currentVol / state.avgVolume : 0;

    const oneMinAgo = ts - 60_000;
    const pastTick = state.prices.findLast((p) => p.ts <= oneMinAgo);
    const surgePct = pastTick ? ((price - pastTick.price) / pastTick.price) * 100 : 0;

    if (state.float >= s.maxFloatM) return;
    if (relVol < s.minRelativeVolume) return;
    if (surgePct < s.minPriceSurgePct) return;

    const lastAlert = this.alertCooldown.get(symbol) ?? 0;
    if (ts - lastAlert < 5 * 60_000) return;
    this.alertCooldown.set(symbol, ts);

    const triggerReasons = [
      `RVOL ${relVol.toFixed(1)}×`,
      `+${surgePct.toFixed(2)}% in 1 min`,
      `Float ${state.float.toFixed(1)}M`,
    ];

    const alert: ScannerAlert = {
      symbol, price, priceChangePct: surgePct, volume: currentVol,
      relativeVolume: relVol, float: state.float,
      marketCap: price * state.float * 1_000_000,
      timestamp: ts, triggerReasons,
    };

    logger.success(
      'scanner',
      `🚨 ALERT: ${symbol} @ $${price.toFixed(2)} — ${triggerReasons.join(' | ')}`,
      { alert }
    );
    this.emit('alert', alert);
  }
}

/**
 * Known float sizes (millions) for common low-float micro-caps.
 * Add/update as needed — anything not listed defaults to 15M.
 */
const FLOAT_MAP: Record<string, number> = {
  CLOV: 9.2,  ATER: 3.1,  PROG: 4.8,  BBIG: 6.7,  EXPR: 5.3,
  MRIN: 2.4,  PHUN: 3.8,  VVPR: 1.2,  GFAI: 5.1,  SOPA: 1.8,
  MULN: 8.9,  EEIQ: 2.0,  CLPS: 4.4,  CLRB: 3.6,  BLNK: 7.1,
  ENVB: 1.5,  NILE: 2.2,  ABIO: 1.9,  TTOO: 3.3,  GOVX: 4.0,
};

/** Default watchlist — edit freely or set via agent.setWatchlist(). */
export const DEFAULT_WATCHLIST = Object.keys(FLOAT_MAP);
