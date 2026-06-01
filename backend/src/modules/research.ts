import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { ScannerAlert, CatalystScore } from '../types';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an elite quantitative analyst specializing in micro-cap, low-float momentum stocks.
Your job is to evaluate whether a sudden price/volume spike in a stock has a legitimate fundamental catalyst behind it.

You will receive:
- Ticker symbol and current price action data
- Recent news headlines (if available)
- SEC filing summaries (if available)

Respond ONLY with a valid JSON object matching this exact schema:
{
  "score": <integer 0-100>,
  "sentiment": <"bullish" | "bearish" | "neutral">,
  "catalystType": <string — e.g. "FDA Approval", "Earnings Beat", "Contract Win", "Short Squeeze", "No Clear Catalyst">,
  "headline": <string — the single most relevant headline or "No material news found">,
  "reasoning": <string — 2-3 sentences explaining your score>,
  "confidence": <float 0.0-1.0>
}

Scoring guide:
90-100: Confirmed binary event (FDA approval, merger announcement, earnings massive beat)
70-89 : Strong fundamental catalyst (phase trial results, large contract, analyst upgrade)
50-69 : Moderate catalyst or unconfirmed rumour
30-49 : Technical move, sympathy play, low-quality news
0-29  : No catalyst, likely pump, or bearish catalyst`;

/**
 * AI Research Agent
 *
 * Uses Claude to score the fundamental catalyst behind a scanner alert.
 * Results are cached in memory for 10 minutes to avoid redundant API calls.
 */
export class ResearchAgent {
  private cache = new Map<string, { score: CatalystScore; expiry: number }>();
  private readonly cacheTtl = 10 * 60_000;

  async analyze(alert: ScannerAlert, newsHeadlines: string[] = []): Promise<CatalystScore> {
    const cacheKey = `${alert.symbol}:${Math.floor(alert.timestamp / 60_000)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      logger.info('research', `Cache hit for ${alert.symbol} — skipping LLM call.`);
      return cached.score;
    }

    logger.info(
      'research',
      `Analyzing catalyst for ${alert.symbol} @ $${alert.price.toFixed(2)}…`
    );

    const userContent = this.buildPrompt(alert, newsHeadlines);

    const message = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

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
