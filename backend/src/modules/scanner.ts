import EventEmitter from 'events';
import {
  IBApi,
  EventName,
  Contract,
  SecType,
  Currency,
  ScannerSubscription,
  TagValue,
} from '@stoqey/ib';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { ScannerAlert } from '../types';

interface TickState {
  prices: { price: number; ts: number }[];
  volumes: number[];
  avgVolume: number;
  float: number;        // shares float in millions (from fundamentals)
  lastPrice: number;
}

/**
 * Real-Time Market Scanner — IBKR
 *
 * Two-stage approach:
 *   1. reqScannerSubscription — asks TWS for the top 50 % gainers in the
 *      $1-$10 price band with high volume.  Refreshes every ~30 s.
 *   2. reqMktData — subscribes to Level-1 ticks for each candidate symbol
 *      and evaluates RVOL + 1-min price surge + float criteria.
 *
 * Emits 'alert' events for qualifying tickers.
 */
export class MarketScanner extends EventEmitter {
  private ib: IBApi;
  private tickState = new Map<string, TickState>();
  private symbolToReqId = new Map<string, number>();
  private reqIdToSymbol = new Map<number, string>();
  private alertCooldown = new Map<string, number>();
  private scanReqId = 9000;
  private nextReqId = 1;
  private running = false;

  constructor(ib: IBApi) {
    super();
    this.ib = ib;
  }

  start() {
    if (this.running) return;
    this.running = true;
    logger.info('scanner', 'IBKR market scanner starting…');
    this.attachTickHandlers();
    this.requestScan();
  }

  stop() {
    this.running = false;
    // Cancel all market data subscriptions
    for (const reqId of this.symbolToReqId.values()) {
      this.ib.cancelMktData(reqId);
    }
    this.ib.cancelScannerSubscription(this.scanReqId);
    logger.info('scanner', 'Market scanner stopped.');
  }

  // ── Scanner subscription ─────────────────────────────────────────────────

  private requestScan() {
    const sub: ScannerSubscription = {
      instrument: 'STK',
      locationCode: 'STK.US.MAJOR',
      scanCode: 'MOST_ACTIVE',         // highest volume movers
      abovePrice: config.MIN_PRICE,
      belowPrice: config.MAX_PRICE,
      aboveVolume: 500_000,
      numberOfRows: 50,
    };

    const filterOptions: TagValue[] = [
      { tag: 'changePercAbove', value: config.MIN_PRICE_SURGE_PCT.toString() },
    ];

    logger.info('scanner', `Requesting IBKR scanner subscription (reqId ${this.scanReqId})…`);
    this.ib.reqScannerSubscription(this.scanReqId, sub, [], filterOptions);

    this.ib.on(EventName.scannerData, (reqId, rank, contractDetails, distance, benchmark, projection, legsStr) => {
      if (reqId !== this.scanReqId) return;
      const symbol = contractDetails.contract.symbol!;
      if (!this.symbolToReqId.has(symbol)) {
        this.subscribeToTicker(symbol, contractDetails.contract);
      }
    });

    // Re-run scan every 60 s to pick up new movers
    if (this.running) setTimeout(() => this.requestScan(), 60_000);
  }

  private subscribeToTicker(symbol: string, contract: Partial<Contract>) {
    const reqId = this.nextReqId++;
    this.symbolToReqId.set(symbol, reqId);
    this.reqIdToSymbol.set(reqId, symbol);
    this.tickState.set(symbol, {
      prices: [],
      volumes: [],
      avgVolume: 0,
      float: 10,      // default; updated via reqFundamentalData below
      lastPrice: 0,
    });

    const fullContract: Contract = {
      symbol,
      secType: SecType.STK,
      currency: Currency.USD,
      exchange: 'SMART',
      ...contract,
    };

    // Tick types: 0=BidSize 1=Bid 2=Ask 3=AskSize 4=Last 5=LastSize 8=Volume
    this.ib.reqMktData(reqId, fullContract, '233', false, false, []);
    logger.info('scanner', `Subscribed to market data for ${symbol} (reqId ${reqId})`);

    // Request short-sale float data (generic tick 236 = shortable, use fundamentals for float)
    this.requestFloat(symbol, fullContract);
  }

  private requestFloat(symbol: string, contract: Contract) {
    const reqId = this.nextReqId++;
    this.ib.reqFundamentalData(reqId, contract, 'ReportSnapshot', []);
    this.ib.once(EventName.fundamentalData, (fReqId, xml: string) => {
      if (fReqId !== reqId) return;
      // Parse float from XML — IBKR returns REPS (Reuters Fundamental Data)
      const match = xml.match(/<MKTCAP[^>]*>([\d.]+)<\/MKTCAP>/);
      const priceMatch = xml.match(/<NPRICE[^>]*>([\d.]+)<\/NPRICE>/);
      if (match && priceMatch) {
        const mktCapM = parseFloat(match[1]);
        const price = parseFloat(priceMatch[1]);
        if (price > 0) {
          const floatM = mktCapM / price;  // rough proxy
          const state = this.tickState.get(symbol);
          if (state) state.float = floatM;
        }
      }
    });
  }

  // ── Tick handlers ────────────────────────────────────────────────────────

  private attachTickHandlers() {
    this.ib.on(EventName.tickPrice, (reqId, tickType, price) => {
      const symbol = this.reqIdToSymbol.get(reqId);
      if (!symbol || price <= 0) return;
      // tickType 4 = Last price
      if (tickType === 4) this.onLastPrice(symbol, price);
    });

    this.ib.on(EventName.tickSize, (reqId, tickType, size) => {
      const symbol = this.reqIdToSymbol.get(reqId);
      if (!symbol) return;
      // tickType 8 = Volume (day volume in lots of 100 on US stocks = shares)
      if (tickType === 8) this.onVolume(symbol, Number(size));
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
    // Recalculate rolling average excluding the latest data point
    const slice = state.volumes.slice(0, -1);
    state.avgVolume = slice.length
      ? slice.reduce((a, b) => a + b, 0) / slice.length
      : 0;
  }

  private evaluate(symbol: string, price: number, ts: number) {
    const state = this.tickState.get(symbol);
    if (!state || state.prices.length < 5) return;
    if (price < config.MIN_PRICE || price > config.MAX_PRICE) return;

    const currentVol = state.volumes[state.volumes.length - 1] ?? 0;
    const relVol = state.avgVolume > 0 ? currentVol / state.avgVolume : 0;

    const oneMinAgo = ts - 60_000;
    const pastTick = state.prices.findLast((p) => p.ts <= oneMinAgo);
    const surgePct = pastTick ? ((price - pastTick.price) / pastTick.price) * 100 : 0;

    const floatOk = state.float < config.MAX_FLOAT_M;
    const rvolOk = relVol >= config.MIN_RELATIVE_VOLUME;
    const surgeOk = surgePct >= config.MIN_PRICE_SURGE_PCT;

    if (!floatOk || !rvolOk || !surgeOk) return;

    const lastAlert = this.alertCooldown.get(symbol) ?? 0;
    if (ts - lastAlert < 5 * 60_000) return;
    this.alertCooldown.set(symbol, ts);

    const triggerReasons = [
      `RVOL ${relVol.toFixed(1)}×`,
      `+${surgePct.toFixed(2)}% in 1 min`,
      `Float ${state.float.toFixed(1)}M`,
    ];

    const alert: ScannerAlert = {
      symbol,
      price,
      priceChangePct: surgePct,
      volume: currentVol,
      relativeVolume: relVol,
      float: state.float,
      marketCap: price * state.float * 1_000_000,
      timestamp: ts,
      triggerReasons,
    };

    logger.success('scanner', `🚨 ALERT: ${symbol} @ $${price.toFixed(2)} — ${triggerReasons.join(' | ')}`, { alert });
    this.emit('alert', alert);
  }
}
