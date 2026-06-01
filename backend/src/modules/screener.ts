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
};

/**
 * Yahoo Finance Market Screener — no API key required.
 *
 * Polls three free Yahoo Finance public screener lists every 30 s:
 *   - day_gainers    : biggest % gainers today
 *   - most_actives   : highest volume today
 *   - small_cap_gainers : small/micro cap movers
 *
 * Results are merged, de-duped, filtered against live settings thresholds,
 * and passed to the scanner which subscribes via IBKR reqMktData.
 */
export class PolygonScreener {   // name kept for agent.ts compatibility
  private intervalHandle: NodeJS.Timeout | null = null;
  private onResults: ((results: ScreenerResult[]) => void) | null = null;

  start(callback: (results: ScreenerResult[]) => void, intervalMs = 30_000) {
    this.onResults = callback;
    this.poll();
    this.intervalHandle = setInterval(() => this.poll(), intervalMs);
    logger.info('scanner', 'Yahoo Finance screener started — polling every 30 s (no API key needed)');
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    logger.info('scanner', 'Yahoo Finance screener stopped.');
  }

  private async poll() {
    const s = settingsStore.get();

    const lists = ['day_gainers', 'most_actives', 'small_cap_gainers'];
    const seen = new Set<string>();
    const candidates: ScreenerResult[] = [];

    for (const listId of lists) {
      try {
        const resp = await axios.get<YFScreenerResponse>(
          'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved',
          {
            params: { scrIds: listId, count: 50, offset: 0 },
            headers: YF_HEADERS,
            timeout: 10_000,
          }
        );

        const quotes = resp.data?.finance?.result?.[0]?.quotes ?? [];

        for (const q of quotes) {
          const symbol = q.symbol;
          if (!symbol || seen.has(symbol)) continue;
          if (!/^[A-Z]{1,5}$/.test(symbol)) continue;  // skip ETFs, warrants etc.
          seen.add(symbol);

          const price      = q.regularMarketPrice ?? 0;
          const changePct  = q.regularMarketChangePercent ?? 0;
          const volume     = q.regularMarketVolume ?? 0;
          const avgVolume  = q.averageDailyVolume3Month ?? 1;
          const relVol     = avgVolume > 0 ? volume / avgVolume : 0;
          const floatShares = q.floatShares ? q.floatShares / 1_000_000 : undefined;

          if (price < s.minPrice || price > s.maxPrice) continue;
          if (changePct < s.minPriceSurgePct) continue;
          if (relVol < s.minRelativeVolume) continue;
          if (volume < 100_000) continue;

          candidates.push({ symbol, price, changePercent: changePct, volume, relativeVolume: relVol, float: floatShares });
        }
      } catch (err) {
        logger.warn('scanner', `Yahoo Finance list "${listId}" failed: ${String(err)}`);
      }
    }

    candidates.sort((a, b) => b.relativeVolume - a.relativeVolume);
    const top = candidates.slice(0, 50);

    if (top.length > 0) {
      logger.success(
        'scanner',
        `Screener: ${top.length} movers — ${top.slice(0, 5).map((c) => `${c.symbol} +${c.changePercent.toFixed(1)}%`).join(', ')}`
      );
    } else {
      logger.info('scanner', 'Screener: 0 movers match thresholds (market may be closed or quiet)');
    }

    this.onResults?.(top);
  }
}

// ── Yahoo Finance types ───────────────────────────────────────────────────────

interface YFScreenerResponse {
  finance: {
    result: [{
      quotes: YFQuote[];
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
