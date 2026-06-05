import EventEmitter from 'events';

export interface AppSettings {
  // Risk
  maxRiskPerTradePct: number;
  maxPositionSizePct: number;  // % of portfolio to deploy per trade (50–100%)
  stopLossPct: number;         // 5–10% for penny stocks
  minTakeProfitPct: number;    // 20–50% target profit
  commissionPerSide: number;   // $ per order leg (buy = 1 side, sell = 1 side)
  minNetProfitDollar: number;  // reject trade if max profit after commissions < this
  maxOpenPositions: number;
  maxDailyLossPct: number;
  // Scanner
  minPrice: number;
  maxPrice: number;
  minRelativeVolume: number;
  maxFloatM: number;
  minPriceSurgePct: number;
  // Research
  minCatalystScore: number;
}

const DEFAULTS: AppSettings = {
  // Risk — tuned for penny stock day-trading with limited capital ($100–$500)
  maxRiskPerTradePct: 3,        // allow up to 3% account risk per trade
  maxPositionSizePct: 90,       // deploy up to 90% of cash — concentrate when capital is scarce
  stopLossPct: 7,               // 7% hard stop — penny stocks need room to breathe
  minTakeProfitPct: 20,         // 20% minimum TP — low enough to actually get hit
  commissionPerSide: 5,         // $5 IBKR fixed per leg
  minNetProfitDollar: 10,       // $10 minimum net profit — low bar for small accounts
  maxOpenPositions: 3,          // adaptive logic in agent will lower this with limited cash
  maxDailyLossPct: 8,           // 8% daily loss limit before circuit breaker
  // Scanner — wider net for penny stock universe
  minPrice: 0.5,                // catch sub-$1 plays
  maxPrice: 20,                 // allow up to $20 for higher-priced movers
  minRelativeVolume: 2,         // 2× avg vol minimum — lower than 3× to catch early moves
  maxFloatM: 50,                // up to 50M float — wider than 20M default
  minPriceSurgePct: 3,          // 3% surge minimum — catch earlier in the move
  // Research
  minCatalystScore: 25,         // 25/100 — pure momentum plays qualify
};

/** In-memory settings store. Emits 'change' when updated. */
class SettingsStore extends EventEmitter {
  private current: AppSettings = { ...DEFAULTS };

  get(): AppSettings {
    return { ...this.current };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.current = { ...this.current, ...patch };
    this.emit('change', this.current);
    return this.get();
  }

  reset(): AppSettings {
    this.current = { ...DEFAULTS };
    this.emit('change', this.current);
    return this.get();
  }
}

export const settingsStore = new SettingsStore();
