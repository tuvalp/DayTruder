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

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

/**
 * Yahoo Finance Full Market Screener — no API key required.
 *
 * Uses Yahoo's query2 screener endpoint to scan the ENTIRE US market
 * (8000+ stocks) and filter server-side for:
 *   - Price between minPrice and maxPrice
 *   - Volume > 500k
 *   - Day gain > minPriceSurgePct%
 *
 * Returns up to 250 results per poll, sorted by % change descending.
 * Runs every 30 s during market hours.
 */
export class PolygonScreener {
  private intervalHandle: NodeJS.Timeout | null = null;
  private onResults: ((results: ScreenerResult[]) => void) | null = null;

  start(callback: (results: ScreenerResult[]) => void, intervalMs = 30_000) {
    this.onResults = callback;
    this.poll();
    this.intervalHandle = setInterval(() => this.poll(), intervalMs);
    logger.info('scanner', 'Full market screener started — scanning entire US market every 30 s');
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    logger.info('scanner', 'Market screener stopped.');
  }

  private async poll() {
    const s = settingsStore.get();

    try {
      const body = {
        offset: 0,
        size: 250,
        sortField: 'percentchange',
        sortType: 'DESC',
        quoteType: 'EQUITY',
        topOperator: 'AND',
        query: {
          operator: 'AND',
          operands: [
            { operator: 'GT', operands: ['intradayprice', s.minPrice] },
            { operator: 'LT', operands: ['intradayprice', s.maxPrice] },
            { operator: 'GT', operands: ['dayvolume', 500_000] },
            { operator: 'GT', operands: ['percentchange', s.minPriceSurgePct] },
          ],
        },
      };

      const resp = await axios.post<YFScreenerResponse>(
        'https://query2.finance.yahoo.com/v1/finance/screener?lang=en-US&region=US',
        body,
        { headers: YF_HEADERS, timeout: 15_000 }
      );

      const quotes = resp.data?.finance?.result?.[0]?.quotes ?? [];
      const candidates: ScreenerResult[] = [];

      for (const q of quotes) {
        const symbol = q.symbol ?? '';
        // Keep only clean US equity symbols (no dots, no dashes — filters ETFs/warrants)
        if (!/^[A-Z]{1,5}$/.test(symbol)) continue;

        const price       = q.regularMarketPrice ?? 0;
        const changePct   = q.regularMarketChangePercent ?? 0;
        const volume      = q.regularMarketVolume ?? 0;
        const avgVolume   = q.averageDailyVolume3Month ?? 1;
        const relVol      = avgVolume > 0 ? volume / avgVolume : 0;
        const floatShares = q.floatShares ? q.floatShares / 1_000_000 : undefined;

        // Apply float filter if available
        if (floatShares !== undefined && floatShares >= s.maxFloatM) continue;

        candidates.push({ symbol, price, changePercent: changePct, volume, relativeVolume: relVol, float: floatShares });
      }

      candidates.sort((a, b) => b.relativeVolume - a.relativeVolume);

      if (candidates.length > 0) {
        logger.success(
          'scanner',
          `Full scan: ${candidates.length} movers in $${s.minPrice}–$${s.maxPrice} range — top: ${candidates.slice(0, 5).map((c) => `${c.symbol} +${c.changePercent.toFixed(1)}%`).join(', ')}`
        );
      } else {
        logger.info('scanner', `Full scan: 0 movers match filters (market may be closed or quiet)`);
      }

      this.onResults?.(candidates);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        logger.warn('scanner', `Yahoo screener failed (${err.response?.status ?? 'network'}): ${err.message}`);
      } else {
        logger.warn('scanner', `Screener error: ${String(err)}`);
      }
    }
  }
}

interface YFScreenerResponse {
  finance: {
    result: [{
      quotes: YFQuote[];
      total: number;
    }];
  };
}

interface YFQuote {
  symbol: string;
  regularMarketPrice: number;
  regularMarketChangePercent: number;
  regularMarketVolume: number;
  averageDailyVolume3Month: number;
  floatShares?: number;
}
