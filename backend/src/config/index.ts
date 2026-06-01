import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  // Brokerage — Alpaca (paper or live)
  ALPACA_API_KEY: z.string().min(1),
  ALPACA_SECRET_KEY: z.string().min(1),
  ALPACA_BASE_URL: z.string().url().default('https://paper-api.alpaca.markets'),
  ALPACA_DATA_URL: z.string().url().default('https://stream.data.alpaca.markets'),

  // AI
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-6'),

  // Database
  DATABASE_URL: z.string().default('postgresql://alphaagent:alphaagent@localhost:5432/alphaagent'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Risk defaults (overridable at runtime)
  MAX_RISK_PER_TRADE_PCT: z.coerce.number().default(1.5),
  STOP_LOSS_PCT: z.coerce.number().default(4),
  MAX_OPEN_POSITIONS: z.coerce.number().default(5),
  MAX_DAILY_LOSS_PCT: z.coerce.number().default(6),

  // Scanner thresholds
  MIN_PRICE: z.coerce.number().default(1),
  MAX_PRICE: z.coerce.number().default(10),
  MIN_RELATIVE_VOLUME: z.coerce.number().default(3),
  MAX_FLOAT_M: z.coerce.number().default(20),  // millions
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
