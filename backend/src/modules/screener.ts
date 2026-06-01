import axios from 'axios';
import { config } from '../config';
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
 * Polygon.io Market Screener
 *
 * Polls the Polygon snapshot endpoint every `intervalMs` to find US stocks
 * matching the scanner thresholds (price range, % gain, volume).
 * Returns a ranked list of candidates that the scanner then subscribes to
 * via IBKR reqMktData for execution-quality tick data.
 *
 * Free tier: unlimited calls, 15-min delayed data (sufficient for discovery).
 * Paid tier: real-time snapshots.
 */
export class PolygonScreener {
  private baseUrl = 'https://api.polygon.io';
  private intervalHandle: NodeJS.Timeout | null = null;
  private onResults: ((results: ScreenerResult[]) => void) | null = null;

  start(callback: (results: ScreenerResult[]) => void, intervalMs = 60_000) {
    this.onResults = callback;
    logger.info('scanner', 'Polygon screener started — polling every 60 s…');
    this.poll();
    this.intervalHandle = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    logger.info('scanner', 'Polygon screener stopped.');
  }

  private async poll() {
    const s = settingsStore.get();
    try {
      // Snapshot endpoint — returns all US tickers with price/volume/change
      const resp = await axios.get<PolygonSnapshotResponse>(
        `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers`,
        {
          params: {
            apiKey: config.POLYGON_API_KEY,
            include_otc: false,
          },
          timeout: 15_000,
        }
      );

      if (resp.data.status !== 'OK') {
        logger.warn('scanner', `Polygon snapshot returned status: ${resp.data.status}`);
        return;
      }

      const tickers = resp.data.tickers ?? [];
      logger.info('scanner', `Polygon snapshot: ${tickers.length} tickers received`);

      const candidates: ScreenerResult[] = [];

      for (const t of tickers) {
        const price = t.day?.c ?? t.lastTrade?.p ?? 0;
        const open  = t.day?.o ?? price;
        const vol   = t.day?.v ?? 0;
        const prevVol = t.prevDay?.v ?? 1;
        const changePct = open > 0 ? ((price - open) / open) * 100 : 0;
        const relVol = prevVol > 0 ? vol / prevVol : 0;

        if (price < s.minPrice || price > s.maxPrice) continue;
        if (changePct < s.minPriceSurgePct) continue;
        if (relVol < s.minRelativeVolume) continue;
        if (vol < 100_000) continue;  // ignore illiquid tickers

        candidates.push({
          symbol: t.ticker,
          price,
          changePercent: changePct,
          volume: vol,
          relativeVolume: relVol,
        });
      }

      // Sort by relative volume descending, take top 30
      candidates.sort((a, b) => b.relativeVolume - a.relativeVolume);
      const top = candidates.slice(0, 30);

      logger.success(
        'scanner',
        `Polygon screener: ${top.length} candidates — top: ${top.slice(0, 5).map((c) => `${c.symbol}(${c.changePercent.toFixed(1)}%)`).join(', ')}`
      );

      this.onResults?.(top);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 403) {
        logger.error('scanner', 'Polygon API key invalid or expired — check POLYGON_API_KEY in .env');
      } else {
        logger.warn('scanner', `Polygon poll failed: ${String(err)}`);
      }
    }
  }
}

// ── Polygon API types ────────────────────────────────────────────────────────

interface PolygonSnapshotResponse {
  status: string;
  tickers: PolygonTicker[];
}

interface PolygonTicker {
  ticker: string;
  day?: { o: number; c: number; v: number };
  prevDay?: { v: number };
  lastTrade?: { p: number };
}
