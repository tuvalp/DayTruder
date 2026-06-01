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
 * Polls the snapshot endpoint every 30 s for all US stocks and returns
 * today's actual movers filtered by the live settings thresholds.
 * Results drive the scanner's dynamic watchlist — no static symbols anywhere.
 *
 * Free tier: 15-min delayed snapshots (fine for discovery).
 * Paid Starter+: real-time snapshots.
 */
export class PolygonScreener {
  private intervalHandle: NodeJS.Timeout | null = null;
  private onResults: ((results: ScreenerResult[]) => void) | null = null;

  start(callback: (results: ScreenerResult[]) => void, intervalMs = 30_000) {
    this.onResults = callback;
    // Fire immediately so the scanner has symbols from the first second
    this.poll();
    this.intervalHandle = setInterval(() => this.poll(), intervalMs);
    logger.info('scanner', 'Polygon screener started — polling every 30 s for today\'s movers');
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    logger.info('scanner', 'Polygon screener stopped.');
  }

  private async poll() {
    const s = settingsStore.get();
    try {
      const resp = await axios.get<PolygonSnapshotResponse>(
        'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers',
        {
          params: { apiKey: config.POLYGON_API_KEY, include_otc: false },
          timeout: 15_000,
        }
      );

      if (resp.data.status !== 'OK' && resp.data.status !== 'DELAYED') {
        logger.warn('scanner', `Polygon returned status: ${resp.data.status}`);
        return;
      }

      const tickers = resp.data.tickers ?? [];
      const candidates: ScreenerResult[] = [];

      for (const t of tickers) {
        const price   = t.day?.c ?? t.lastTrade?.p ?? 0;
        const open    = t.day?.o ?? price;
        const vol     = t.day?.v ?? 0;
        const prevVol = t.prevDay?.v ?? 1;
        const changePct  = open > 0 ? ((price - open) / open) * 100 : 0;
        const relVol     = prevVol > 0 ? vol / prevVol : 0;

        if (price < s.minPrice || price > s.maxPrice) continue;
        if (changePct < s.minPriceSurgePct) continue;
        if (relVol < s.minRelativeVolume) continue;
        if (vol < 100_000) continue;

        candidates.push({
          symbol: t.ticker,
          price,
          changePercent: changePct,
          volume: vol,
          relativeVolume: relVol,
          // Polygon free tier doesn't include float — left undefined,
          // scanner defaults to 15M and IBKR fundamental data refines it.
        });
      }

      candidates.sort((a, b) => b.relativeVolume - a.relativeVolume);
      const top = candidates.slice(0, 50);

      if (top.length > 0) {
        logger.success(
          'scanner',
          `Screener: ${top.length} movers today — ${top.slice(0, 5).map((c) => `${c.symbol} +${c.changePercent.toFixed(1)}%`).join(', ')}`
        );
      } else {
        logger.info('scanner', 'Screener: no movers match current thresholds (market may be closed)');
      }

      this.onResults?.(top);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 403) {
        logger.error('scanner', 'Polygon API key invalid — check POLYGON_API_KEY in .env');
      } else {
        logger.warn('scanner', `Polygon poll failed: ${String(err)}`);
      }
    }
  }
}

interface PolygonSnapshotResponse {
  status: string;
  tickers: PolygonTicker[];
}

interface PolygonTicker {
  ticker: string;
  day?:     { o: number; c: number; v: number };
  prevDay?: { v: number };
  lastTrade?: { p: number };
}
