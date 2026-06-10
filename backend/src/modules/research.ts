import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { ScannerAlert, CatalystScore } from '../types';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an elite day-trading analyst specializing in micro-cap, low-float momentum and breakout stocks.
Your job is to evaluate whether a price/volume surge is a tradeable opportunity — with OR without a fundamental catalyst.

Low-float stocks ($1–$10, float < 20M) often move violently on pure momentum, short squeezes, or sector sympathy.
These ARE valid trading setups even without news. Do NOT penalize a trade for lacking fundamental news.

You will receive ticker symbol, price action, RVOL, and float. News headlines may or may not be present.

Respond ONLY with a valid JSON object matching this exact schema:
{
  "score": <integer 0-100>,
  "sentiment": <"bullish" | "bearish" | "neutral">,
  "catalystType": <string — e.g. "FDA Approval", "Earnings Beat", "Short Squeeze", "Breakout Pattern", "Sympathy Play", "Momentum Run", "No Clear Catalyst">,
  "headline": <string — most relevant headline, or "Pure price-action momentum — no news">,
  "reasoning": <string — 2-3 sentences on tradeability, float squeeze potential, and risk>,
  "confidence": <float 0.0-1.0>
}

Scoring guide — focus on TRADEABILITY, not just fundamentals:
90-100: Confirmed binary catalyst (FDA approval, merger, massive earnings beat) + strong price action
70-89 : Clear fundamental catalyst or confirmed short squeeze with extreme RVOL (≥ 10×)
50-69 : Moderate catalyst, sympathy play with strong sector momentum, or clean breakout with RVOL ≥ 5×
35-49 : Pure momentum/breakout with RVOL ≥ 3× — valid low-float day-trade, no news required
20-34 : Weak signal — low RVOL, suspect move, or clearly negative catalyst
0-19  : Do NOT trade — bearish catalyst, halt risk, or obvious pump-and-dump red flags

IMPORTANT: A low-float stock with RVOL ≥ 3× and surge ≥ 5% scores at least 35 by default.
Never score a genuine high-RVOL breakout below 30 just because there is no news.`;

/**
 * AI Research Agent
 *
 * Uses Claude to score the fundamental catalyst behind a scanner alert.
 * Results are cached in memory for 10 minutes to avoid redundant API calls.
 */
export class ResearchAgent {
  private cache = new Map<string, { score: CatalystScore; expiry: number }>();
  private readonly cacheTtl = 10 * 60_000;
  // Deduplicates concurrent calls for the same symbol — all callers await the same Promise
  private inFlight = new Map<string, Promise<CatalystScore>>();
  // When the Anthropic account is out of credits, stop hammering the API and
  // fall back to momentum-only scoring until this timestamp
  private apiBackoffUntil = 0;
  private readonly creditBackoffMs = 15 * 60_000;

  async analyze(alert: ScannerAlert, newsHeadlines: string[] = []): Promise<CatalystScore> {
    const cacheKey = `${alert.symbol}:${Math.floor(alert.timestamp / 60_000)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      logger.info('research', `Cache hit for ${alert.symbol} — skipping LLM call.`);
      return cached.score;
    }

    // If a call for this key is already running, share it instead of firing a new one
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      logger.info('research', `${alert.symbol} — joining in-flight analysis`);
      return existing;
    }

    const promise = this._doAnalyze(alert, newsHeadlines, cacheKey).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  private async _doAnalyze(alert: ScannerAlert, newsHeadlines: string[], cacheKey: string): Promise<CatalystScore> {
    if (Date.now() < this.apiBackoffUntil) {
      return this.momentumFallback(alert, cacheKey);
    }

    logger.info('research', `Analyzing catalyst for ${alert.symbol} @ $${alert.price.toFixed(2)}…`);
    const userContent = this.buildPrompt(alert, newsHeadlines);

    let message;
    try {
      message = await client.messages.create({
        model: config.CLAUDE_MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/credit balance/i.test(msg)) {
        this.apiBackoffUntil = Date.now() + this.creditBackoffMs;
        logger.error('research', `🔴 Anthropic API out of credits — falling back to momentum-only scoring for ${this.creditBackoffMs / 60_000} min. Add credits at console.anthropic.com → Plans & Billing.`);
      } else {
        logger.error('research', `Claude API error for ${alert.symbol}: ${msg} — using momentum fallback`);
      }
      return this.momentumFallback(alert, cacheKey);
    }

    const rawText = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    let parsed: Omit<CatalystScore, 'symbol' | 'analyzedAt'>;
    try {
      // Strip markdown fences if present
      const json = rawText.replace(/```json\n?|\n?```/g, '').trim();
      parsed = JSON.parse(json);
    } catch {
      logger.error('research', `Failed to parse Claude response for ${alert.symbol}`, {
        raw: rawText,
      });
      parsed = {
        score: 0,
        sentiment: 'neutral',
        catalystType: 'Parse Error',
        headline: 'Unable to parse AI response',
        reasoning: rawText.slice(0, 200),
        confidence: 0,
      };
    }

    const result: CatalystScore = {
      symbol: alert.symbol,
      analyzedAt: Date.now(),
      ...parsed,
    };

    logger.info(
      'research',
      `${alert.symbol} catalyst score: ${result.score}/100 (${result.catalystType}) — "${result.headline}"`,
      { result }
    );

    this.cache.set(cacheKey, { score: result, expiry: Date.now() + this.cacheTtl });
    return result;
  }

  /**
   * Momentum-only score used when the Claude API is unavailable.
   * Mirrors the bottom rungs of the LLM scoring guide: a genuine low-float
   * high-RVOL surge still qualifies as a tradeable setup without news.
   */
  private momentumFallback(alert: ScannerAlert, cacheKey: string): CatalystScore {
    const strongMomentum = alert.relativeVolume >= 3 && alert.priceChangePct >= 5;
    const moderateMomentum = alert.relativeVolume >= 2 && alert.priceChangePct >= 3;
    const score = strongMomentum ? 35 : moderateMomentum ? 28 : 15;
    const result: CatalystScore = {
      symbol: alert.symbol,
      analyzedAt: Date.now(),
      score,
      sentiment: score >= 28 ? 'bullish' : 'neutral',
      catalystType: 'Momentum Fallback (AI unavailable)',
      headline: 'Scored from price/volume only — Claude API unavailable',
      reasoning: `RVOL ${alert.relativeVolume.toFixed(1)}×, surge +${alert.priceChangePct.toFixed(1)}%, float ${alert.float.toFixed(1)}M. No news/catalyst verification possible.`,
      confidence: 0.5,
    };
    logger.warn('research', `${alert.symbol} momentum-fallback score: ${score}/100 (AI unavailable)`);
    this.cache.set(cacheKey, { score: result, expiry: Date.now() + this.cacheTtl });
    return result;
  }

  private buildPrompt(alert: ScannerAlert, headlines: string[]): string {
    return [
      `=== STOCK ALERT DATA ===`,
      `Symbol: ${alert.symbol}`,
      `Current Price: $${alert.price.toFixed(2)}`,
      `1-Minute Price Change: +${alert.priceChangePct.toFixed(2)}%`,
      `Relative Volume: ${alert.relativeVolume.toFixed(1)}×`,
      `Float: ${alert.float.toFixed(1)}M shares`,
      `Market Cap: $${(alert.marketCap / 1_000_000).toFixed(1)}M`,
      `Trigger Reasons: ${alert.triggerReasons.join(', ')}`,
      ``,
      `=== RECENT NEWS HEADLINES ===`,
      headlines.length > 0
        ? headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')
        : 'No headlines provided — infer from general knowledge and price action context.',
      ``,
      `Evaluate the above and return the JSON analysis.`,
    ].join('\n');
  }
}
