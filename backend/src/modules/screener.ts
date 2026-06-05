import EventEmitter from 'events';
import axios from 'axios';
import { logger } from '../utils/logger';
import { settingsStore } from './settings';

export interface ScreenerResult {
  symbol: string;
  price: number;
  changePercent: number;
  volume: number;
  relativeVolume: number;
  float?: number;
}

/**
 * Full Market Screener — Nasdaq public stock CSV (no API key, no auth).
 *
 * Runs independently as a self-contained stream. Emits 'symbols' every 30 s.
 * The scanner (or any other consumer) subscribes to those events.
 *
 * Endpoint: api.nasdaq.com/api/screener/stocks?download=true
 * Returns ALL ~8,000 US-listed stocks (NYSE + Nasdaq + AMEX).
 */
export class PolygonScreener extends EventEmitter {
  private intervalHandle: NodeJS.Timeout | null = null;

  start(intervalMs = 30_000) {
    this.poll();
    this.intervalHandle = setInterval(() => this.poll(), intervalMs);
    logger.info('scanner', 'Full market screener started — scanning all 8000+ US stocks every 30 s');
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    logger.info('scanner', 'Full market screener stopped.');
  }

  private async poll() {
    const s = settingsStore.get();
    try {
      const { data } = await axios.get<NasdaqResponse>(
        'https://api.nasdaq.com/api/screener/stocks',
        {
          params: { tableonly: true, limit: 10_000, download: true },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            'Accept': 'application/json, text/plain, */*',
          },
          timeout: 20_000,
        }
      );

      const rows = data?.data?.rows ?? [];
      logger.info('scanner', `Nasdaq feed: ${rows.length} total US stocks received`);

      const candidates: ScreenerResult[] = [];

      for (const row of rows) {
        const symbol = (row.symbol ?? '').trim();
        if (!/^[A-Z]{1,5}$/.test(symbol)) continue;

        const price     = parsePrice(row.lastsale);
        const changePct = parseFloat(row.pctchange?.replace('%', '') ?? '0');
        const volume    = parseInt(row.volume?.replace(/,/g, '') ?? '0', 10);
        const marketCap = parseMarketCap(row.marketCap);

        if (price < s.minPrice || price > s.maxPrice) continue;
        if (changePct < s.minPriceSurgePct) continue;
        if (volume < 300_000) continue;

        const floatProxy = marketCap > 0 ? marketCap / price / 1_000_000 : undefined;
        if (floatProxy !== undefined && floatProxy >= s.maxFloatM) continue;

        candidates.push({
          symbol,
          price,
          changePercent: changePct,
          volume,
          relativeVolume: 1,
          float: floatProxy,
        });
      }

      candidates.sort((a, b) => b.changePercent - a.changePercent);

      if (candidates.length > 0) {
        logger.success(
          'scanner',
          `Full scan: ${candidates.length} movers in $${s.minPrice}–$${s.maxPrice} — top: ${
            candidates.slice(0, 5).map((c) => `${c.symbol} +${c.changePercent.toFixed(1)}%`).join(', ')
          }`
        );
      } else {
        logger.info('scanner', 'Full scan: 0 movers match thresholds (market may be closed)');
      }

      // Emit independently — consumers subscribe, agent doesn't drive this
      this.emit('symbols', candidates);
    } catch (err) {
      logger.warn('scanner', `Full scan failed: ${String(err)}`);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePrice(raw: string | undefined): number {
  if (!raw) return 0;
  return parseFloat(raw.replace('$', '').replace(',', '')) || 0;
}

function parseMarketCap(raw: string | undefined): number {
  if (!raw || raw === '') return 0;
  const n = parseFloat(raw);
  if (isNaN(n)) return 0;
  if (raw.endsWith('B')) return n * 1_000_000_000;
  if (raw.endsWith('M')) return n * 1_000_000;
  if (raw.endsWith('K')) return n * 1_000;
  return n;
}

// ── Nasdaq API types ──────────────────────────────────────────────────────────

interface NasdaqResponse {
  data: {
    rows: NasdaqRow[];
  };
}

interface NasdaqRow {
  symbol: string;
  lastsale: string;
  pctchange: string;
  volume: string;
  marketCap: string;
}
