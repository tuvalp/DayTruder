import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  // ── IBKR (TWS / IB Gateway must be running locally) ──────────────────────
  IBKR_HOST: z.string().default('127.0.0.1'),
  IBKR_PORT: z.coerce.number().default(7496),
  IBKR_CLIENT_ID: z.coerce.number().default(1),
  // Account is auto-detected from TWS on connect — only set this to force a specific account
  IBKR_ACCOUNT: z.string().optional(),

  // ── Market Data ───────────────────────────────────────────────────────────
  // Free key at https://finnhub.io — 60 calls/min, no credit card required
  FINNHUB_API_KEY: z.string().min(1),

  // ── AI ────────────────────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-6'),

  // ── Infrastructure ────────────────────────────────────────────────────────
  DATABASE_URL: z.string().default('postgresql://alphaagent:alphaagent@localhost:5432/alphaagent'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌  Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
