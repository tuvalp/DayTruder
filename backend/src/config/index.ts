import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  // ── IBKR (TWS / IB Gateway must be running locally) ──────────────────────
  IBKR_HOST: z.string().default('127.0.0.1'),
  // Paper TWS=7497  Live TWS=7496  Paper Gateway=4002  Live Gateway=4001
  IBKR_PORT: z.coerce.number().default(7497),
  IBKR_CLIENT_ID: z.coerce.number().default(1),
  // Account number shown in TWS — e.g. DU1234567 (paper) or U1234567 (live)
  IBKR_ACCOUNT: z.string().min(1),

  // ── AI ────────────────────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-6'),

  // ── Infrastructure ────────────────────────────────────────────────────────
  DATABASE_URL: z.string().default('postgresql://alphaagent:alphaagent@localhost:5432/alphaagent'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ── Risk defaults ─────────────────────────────────────────────────────────
  MAX_RISK_PER_TRADE_PCT: z.coerce.number().default(1.5),
  STOP_LOSS_PCT: z.coerce.number().default(4),
  MAX_OPEN_POSITIONS: z.coerce.number().default(5),
  MAX_DAILY_LOSS_PCT: z.coerce.number().default(6),

  // ── Scanner thresholds ────────────────────────────────────────────────────
  MIN_PRICE: z.coerce.number().default(1),
  MAX_PRICE: z.coerce.number().default(10),
  MIN_RELATIVE_VOLUME: z.coerce.number().default(3),
  MAX_FLOAT_M: z.coerce.number().default(20),
  MIN_PRICE_SURGE_PCT: z.coerce.number().default(5),
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
