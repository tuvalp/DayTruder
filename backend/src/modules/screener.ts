import yahooFinance from 'yahoo-finance2';
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

// Suppress yahoo-finance2 validation warnings in the log
yahooFinance.setGlobalConfig({ validation: { logErrors: false } });

/**
 * Yahoo Finance 2 Full Market Screener — no API key, handles auth internally.
 *
 * Queries the full US equity universe with server-side filters:
 *   price $1–$10, volume > 500k, day change > minPriceSurgePct%
 *
 * Returns up to 250 movers per poll sorted by relative volume.
 */
export class PolygonScreener {
  private intervalHandle: NodeJS.Timeout | null = null;
  private onResults: ((results: ScreenerResult[]) => void) | null = null;

  start(callback: (results: ScreenerResult[]) => void, intervalMs = 30_000) {
    this.onResults = callback;
    this.poll();
    this.intervalHandle = setInterval(() => this.poll(), intervalMs);
    logger.info('scanner', 'Full market screener started (yahoo-finance2) — polling every 30 s');
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    logger.info('scanner', 'Market screener stopped.');
  }

  private async poll() {
    const s = settingsStore.get();
    try {
      const result = await yahooFinance.screener(
        {
          scrIds: 'day_gainers',
          count: 250,
        },
        {
          fields: [
            'symbol', 'regularMarketPrice', 'regularMarketChangePercent',
            'regularMarketVolume', 'averageDailyVolume3Month', 'floatShares',
          ],
        }
      );

      const quotes = result.quotes ?? [];
      const candidates: ScreenerResult[] = [];

      for (const q of quotes) {
        const symbol     = q.symbol ?? '';
        if (!/^[A-Z]{1,5}$/.test(symbol)) continue;  // skip ETFs / warrants

        const price     = (q as Record<string, number>).regularMarketPrice ?? 0;
        const changePct = (q as Record<string, number>).regularMarketChangePercent ?? 0;
        const volume    = (q as Record<string, number>).regularMarketVolume ?? 0;
        const avgVol    = (q as Record<string, number>).averageDailyVolume3Month ?? 1;
        const relVol    = avgVol > 0 ? volume / avgVol : 0;
        const floatM    = (q as Record<string, number>).floatShares
          ? (q as Record<string, number>).floatShares / 1_000_000
          : undefined;

        if (price < s.minPrice || price > s.maxPrice) continue;
        if (changePct < s.minPriceSurgePct) continue;
        if (volume < 500_000) continue;
        if (floatM !== undefined && floatM >= s.maxFloatM) continue;

        candidates.push({ symbol, price, changePercent: changePct, volume, relativeVolume: relVol, float: floatM });
      }

      // Also hit most_actives for volume-driven movers
      const activeResult = await yahooFinance.screener(
        { scrIds: 'most_actives', count: 250 },
        { fields: ['symbol', 'regularMarketPrice', 'regularMarketChangePercent', 'regularMarketVolume', 'averageDailyVolume3Month', 'floatShares'] }
      );

      const seen = new Set(candidates.map((c) => c.symbol));
      for (const q of activeResult.quotes ?? []) {
        const symbol = q.symbol ?? '';
        if (!/^[A-Z]{1,5}$/.test(symbol) || seen.has(symbol)) continue;

        const price     = (q as Record<string, number>).regularMarketPrice ?? 0;
        const changePct = (q as Record<string, number>).regularMarketChangePercent ?? 0;
        const volume    = (q as Record<string, number>).regularMarketVolume ?? 0;
        const avgVol    = (q as Record<string, number>).averageDailyVolume3Month ?? 1;
        const relVol    = avgVol > 0 ? volume / avgVol : 0;
        const floatM    = (q as Record<string, number>).floatShares
          ? (q as Record<string, number>).floatShares / 1_000_000
          : undefined;

        if (price < s.minPrice || price > s.maxPrice) continue;
        if (changePct < s.minPriceSurgePct) continue;
        if (volume < 500_000) continue;
        if (floatM !== undefined && floatM >= s.maxFloatM) continue;

        candidates.push({ symbol, price, changePercent: changePct, volume, relativeVolume: relVol, float: floatM });
        seen.add(symbol);
      }

      candidates.sort((a, b) => b.relativeVolume - a.relativeVolume);

      if (candidates.length > 0) {
        logger.success(
          'scanner',
          `Screener: ${candidates.length} movers in $${s.minPrice}–$${s.maxPrice} — top: ${
            candidates.slice(0, 5).map((c) => `${c.symbol} +${c.changePercent.toFixed(1)}%`).join(', ')
          }`
        );
      } else {
        logger.info('scanner', 'Screener: 0 movers match filters (market may be closed or quiet)');
      }

      this.onResults?.(candidates);
    } catch (err) {
      logger.warn('scanner', `Screener poll failed: ${String(err)}`);
    }
  }
}
