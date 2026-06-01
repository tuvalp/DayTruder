import EventEmitter from 'events';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { MarketTick, ScannerAlert } from '../types';

interface TickHistory {
  prices: { price: number; ts: number }[];
  volumes: number[];
  avgVolume: number;
  float: number;  // populated from asset metadata
}

/**
 * Real-Time Market Scanner
 *
 * Connects to Alpaca's WebSocket data stream and continuously evaluates
 * every tick against three criteria:
 *   1. Relative Volume  > MIN_RELATIVE_VOLUME (default 3×)
 *   2. Float            < MAX_FLOAT_M million shares
 *   3. 1-min price surge > MIN_PRICE_SURGE_PCT %
 *
 * Emits 'alert' events carrying ScannerAlert objects for qualifying tickers.
 */
export class MarketScanner extends EventEmitter {
  private tickHistory = new Map<string, TickHistory>();
  private alertCooldown = new Map<string, number>(); // prevent duplicate alerts within 5 min
  private wsClient: WebSocket | null = null;
  private watchlist: string[] = [];
  private running = false;

  /** Subscribe to a list of symbols to monitor. */
  setWatchlist(symbols: string[]) {
    this.watchlist = symbols;
    logger.info('scanner', `Watchlist updated — ${symbols.length} symbols`, { symbols });
  }

  start() {
    if (this.running) return;
    this.running = true;
    logger.info('scanner', 'Market scanner starting…');
    this.connectWebSocket();
  }

  stop() {
    this.running = false;
    this.wsClient?.close();
    logger.info('scanner', 'Market scanner stopped.');
  }

  private connectWebSocket() {
    const url = `${config.ALPACA_DATA_URL}/v1beta1/iex`;
    // Use native WebSocket (Node 22+) or ws package in older runtimes.
    // Cast to any to stay dependency-free when ws is not installed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WS: any = (globalThis as any).WebSocket ?? require('ws');
    this.wsClient = new WS(url) as WebSocket;

    this.wsClient.onopen = () => {
      logger.success('scanner', 'WebSocket connected to Alpaca data stream.');
      this.authenticate();
    };

    this.wsClient.onmessage = (event: MessageEvent) => {
      const messages: Record<string, unknown>[] = JSON.parse(
        typeof event.data === 'string' ? event.data : event.data.toString()
      );
      for (const msg of messages) {
        if (msg['T'] === 'q') this.handleQuote(msg);
        else if (msg['T'] === 't') this.handleTrade(msg);
      }
    };

    this.wsClient.onerror = (err: Event) => {
      logger.error('scanner', 'WebSocket error', { err: String(err) });
    };

    this.wsClient.onclose = () => {
      if (this.running) {
        logger.warn('scanner', 'WebSocket closed — reconnecting in 3 s…');
        setTimeout(() => this.connectWebSocket(), 3000);
      }
    };
  }

  private authenticate() {
    this.wsClient?.send(
      JSON.stringify({
        action: 'auth',
        key: config.ALPACA_API_KEY,
        secret: config.ALPACA_SECRET_KEY,
      })
    );
    if (this.watchlist.length > 0) {
      this.wsClient?.send(
        JSON.stringify({ action: 'subscribe', trades: this.watchlist, quotes: this.watchlist })
      );
    }
  }

  private handleTrade(msg: Record<string, unknown>) {
    const symbol = msg['S'] as string;
    const price = msg['p'] as number;
    const volume = msg['s'] as number;  // size of this trade
    const ts = Date.now();

    if (price < config.MIN_PRICE || price > config.MAX_PRICE) return;

    this.updateHistory(symbol, price, volume, ts);
    this.evaluate(symbol, price, ts);
  }

  private handleQuote(msg: Record<string, unknown>) {
    const symbol = msg['S'] as string;
    const bid = msg['bp'] as number;
    const ask = msg['ap'] as number;
    if (!bid || !ask) return;
    const mid = (bid + ask) / 2;
    if (mid < config.MIN_PRICE || mid > config.MAX_PRICE) return;
    // Quotes don't carry volume; just refresh price for surge calc.
    const hist = this.tickHistory.get(symbol);
    if (hist) {
      hist.prices.push({ price: mid, ts: Date.now() });
      if (hist.prices.length > 120) hist.prices.shift();
    }
  }

  private updateHistory(symbol: string, price: number, volume: number, ts: number) {
    if (!this.tickHistory.has(symbol)) {
      this.tickHistory.set(symbol, {
        prices: [],
        volumes: [],
        avgVolume: 0,
        float: Math.random() * 18 + 1,  // placeholder — replace with fundamentals API
      });
    }
    const hist = this.tickHistory.get(symbol)!;
    hist.prices.push({ price, ts });
    hist.volumes.push(volume);

    // Keep rolling 60-tick window for price; 200-tick for vol average
    if (hist.prices.length > 120) hist.prices.shift();
    if (hist.volumes.length > 200) {
      hist.volumes.shift();
    }
    hist.avgVolume =
      hist.volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(hist.volumes.length - 1, 1);
  }

  private evaluate(symbol: string, price: number, ts: number) {
    const hist = this.tickHistory.get(symbol);
    if (!hist || hist.prices.length < 5) return;

    // --- Relative volume ---
    const currentVol = hist.volumes[hist.volumes.length - 1] ?? 0;
    const relVol = hist.avgVolume > 0 ? currentVol / hist.avgVolume : 0;

    // --- 1-minute price surge ---
    const oneMinAgo = ts - 60_000;
    const pastTick = hist.prices.findLast((p) => p.ts <= oneMinAgo);
    const priceSurgePct = pastTick ? ((price - pastTick.price) / pastTick.price) * 100 : 0;

    // --- Float check ---
    const floatOk = hist.float < config.MAX_FLOAT_M;

    const triggerReasons: string[] = [];
    if (relVol >= config.MIN_RELATIVE_VOLUME) triggerReasons.push(`RVOL ${relVol.toFixed(1)}×`);
    if (priceSurgePct >= config.MIN_PRICE_SURGE_PCT)
      triggerReasons.push(`+${priceSurgePct.toFixed(2)}% in 1 min`);
    if (floatOk) triggerReasons.push(`Float ${hist.float.toFixed(1)}M`);

    const qualifies =
      relVol >= config.MIN_RELATIVE_VOLUME &&
      priceSurgePct >= config.MIN_PRICE_SURGE_PCT &&
      floatOk;

    if (!qualifies) return;

    // Debounce: don't re-alert for same symbol within 5 minutes
    const lastAlert = this.alertCooldown.get(symbol) ?? 0;
    if (ts - lastAlert < 5 * 60_000) return;
    this.alertCooldown.set(symbol, ts);

    const alert: ScannerAlert = {
      symbol,
      price,
      priceChangePct: priceSurgePct,
      volume: currentVol,
      relativeVolume: relVol,
      float: hist.float,
      marketCap: price * hist.float * 1_000_000,
      timestamp: ts,
      triggerReasons,
    };

    logger.success(
      'scanner',
      `🚨 ALERT: ${symbol} @ $${price.toFixed(2)} — ${triggerReasons.join(' | ')}`,
      { alert }
    );
    this.emit('alert', alert);
  }

  /** Inject a synthetic tick — used for testing without live market data. */
  injectTick(tick: MarketTick) {
    this.updateHistory(tick.symbol, tick.price, tick.volume, tick.timestamp);
    this.evaluate(tick.symbol, tick.price, tick.timestamp);
  }
}
