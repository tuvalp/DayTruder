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
 * Finnhub Market Screener
 *
 * Uses two free Finnhub endpoints:
 *   1. /scan/technical-indicator  — fetch US stocks filtered by % change and volume
 *   2. /quote                     — get real-time price/change for each candidate
 *
 * Free tier: 60 API calls/min — sufficient for 30 s polling.
 * No credit card required.
 */
export class PolygonScreener {   // name kept for compatibility with agent.ts
  private baseUrl = 'https://finnhub.io/api/v1';
  private intervalHandle: NodeJS.Timeout | null = null;
  private onResults: ((results: ScreenerResult[]) => void) | null = null;

  start(callback: (results: ScreenerResult[]) => void, intervalMs = 30_000) {
    this.onResults = callback;
    this.poll();
    this.intervalHandle = setInterval(() => this.poll(), intervalMs);
    logger.info('scanner', 'Finnhub screener started — polling every 30 s for today\'s movers');
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    logger.info('scanner', 'Finnhub screener stopped.');
  }

  private async poll() {
    const s = settingsStore.get();
    try {
      // Step 1: get all US stock symbols that are moving today
      const scanResp = await axios.get<FinnhubScanResponse>(
        `${this.baseUrl}/scan/technical-indicator`,
        {
          params: {
            token: config.FINNHUB_API_KEY,
            exchange: 'US',
            resolution: '1',   // 1-minute bars
          },
          timeout: 10_000,
        }
      );

      const symbols: string[] = (scanResp.data?.result ?? [])
        .map((r: { symbol: string }) => r.symbol)
        .filter((sym: string) => /^[A-Z]{1,5}$/.test(sym))  // US equity symbols only
        .slice(0, 80);  // cap to stay within rate limit

      if (symbols.length === 0) {
        logger.info('scanner', 'Finnhub: no symbols returned (market may be closed)');
        return;
      }

      // Step 2: fetch quotes in parallel batches of 15 (rate limit safe)
      const candidates: ScreenerResult[] = [];
      const batches = chunk(symbols, 15);

      for (const batch of batches) {
        const quotes = await Promise.all(
          batch.map((sym) =>
            axios.get<FinnhubQuote>(`${this.baseUrl}/quote`, {
              params: { symbol: sym, token: config.FINNHUB_API_KEY },
              timeout: 5_000,
            }).then((r) => ({ sym, data: r.data })).catch(() => null)
          )
        );

        for (const q of quotes) {
          if (!q || !q.data) continue;
          const { c: price, pc: prevClose, v: volume } = q.data;
          if (!price || !prevClose || price <= 0) continue;

          const changePct = ((price - prevClose) / prevClose) * 100;
          // Rough relative volume: Finnhub doesn't provide avg vol on free tier
          // Use intraday volume proxy (anything > 500k on a mover is significant)
          const relVol = volume > 0 ? volume / 500_000 : 0;

          if (price < s.minPrice || price > s.maxPrice) continue;
          if (changePct < s.minPriceSurgePct) continue;
          if (volume < 100_000) continue;

          candidates.push({
            symbol: q.sym,
            price,
            changePercent: changePct,
            volume,
            relativeVolume: relVol,
          });
        }

        // Small delay between batches to respect rate limit
        await sleep(300);
      }

      candidates.sort((a, b) => b.changePercent - a.changePercent);
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
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        logger.error('scanner', 'Finnhub API key invalid — check FINNHUB_API_KEY in .env');
      } else {
        logger.warn('scanner', `Finnhub poll failed: ${String(err)}`);
      }
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface FinnhubScanResponse {
  result: { symbol: string }[];
}

interface FinnhubQuote {
  c: number;   // current price
  pc: number;  // previous close
  v: number;   // volume
}
