import EventEmitter from 'events';
import {
  IBApi,
  EventName,
  Contract,
  SecType,
  Currency,
  ScannerSubscription,
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
    for (const reqId of this.symbolToReqId.values()) this.ib.cancelMktData(reqId);
    this.ib.cancelScannerSubscription(this.scanReqId);
    logger.info('scanner', 'Market scanner stopped.');
  }

  private requestScan() {
    const s = settingsStore.get();
    const sub: ScannerSubscription = {
      instrument: 'STK',
      locationCode: 'STK.US.MAJOR',
      scanCode: 'MOST_ACTIVE',
      abovePrice: s.minPrice,
      belowPrice: s.maxPrice,
      aboveVolume: 500_000,
      numberOfRows: 50,
    };
    // filterOptions not supported via @stoqey/ib — surge % filtered in evaluate()
    this.ib.reqScannerSubscription(this.scanReqId, sub, [], []);
    this.ib.on(EventName.scannerData, (_reqId, _rank, contractDetails) => {
      const symbol = contractDetails.contract.symbol!;
      if (!this.symbolToReqId.has(symbol)) this.subscribeToTicker(symbol, contractDetails.contract);
    });
    if (this.running) setTimeout(() => this.requestScan(), 60_000);
  }

  private subscribeToTicker(symbol: string, contract: Partial<Contract>) {
    const reqId = this.nextReqId++;
    this.symbolToReqId.set(symbol, reqId);
    this.reqIdToSymbol.set(reqId, symbol);
    this.tickState.set(symbol, { prices: [], volumes: [], avgVolume: 0, float: 10, lastPrice: 0 });
    const full: Contract = { symbol, secType: SecType.STK, currency: Currency.USD, exchange: 'SMART', ...contract };
    this.ib.reqMktData(reqId, full, '233', false, false, []);
    this.requestFloat(symbol, full);
  }

  private requestFloat(symbol: string, contract: Contract) {
    const reqId = this.nextReqId++;
    this.ib.reqFundamentalData(reqId, contract, 'ReportSnapshot', []);
    this.ib.once(EventName.fundamentalData, (fReqId, xml: string) => {
      if (fReqId !== reqId) return;
      const mktCap = xml.match(/<MKTCAP[^>]*>([\d.]+)<\/MKTCAP>/);
      const price  = xml.match(/<NPRICE[^>]*>([\d.]+)<\/NPRICE>/);
      if (mktCap && price) {
        const floatM = parseFloat(mktCap[1]) / parseFloat(price[1]);
        const state = this.tickState.get(symbol);
        if (state) state.float = floatM;
      }
    });
  }

  private attachTickHandlers() {
    this.ib.on(EventName.tickPrice, (reqId, tickType, price) => {
      const symbol = this.reqIdToSymbol.get(reqId);
      if (!symbol || price <= 0) return;
      if (tickType === 4) this.onLastPrice(symbol, price);
    });
    this.ib.on(EventName.tickSize, (reqId, tickType, size) => {
      const symbol = this.reqIdToSymbol.get(reqId);
      if (!symbol) return;
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
    const slice = state.volumes.slice(0, -1);
    state.avgVolume = slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
  }

  private evaluate(symbol: string, price: number, ts: number) {
    const s = settingsStore.get();          // always read live settings
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
      marketCap: price * state.float * 1_000_000, timestamp: ts, triggerReasons,
    };

    logger.success('scanner', `🚨 ALERT: ${symbol} @ $${price.toFixed(2)} — ${triggerReasons.join(' | ')}`, { alert });
    this.emit('alert', alert);
  }
}
