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
  maxRiskPerTradePct: 2,
  maxPositionSizePct: 75,
  stopLossPct: 7,
  minTakeProfitPct: 25,
  commissionPerSide: 5,
  minNetProfitDollar: 20,
  maxOpenPositions: 5,
  maxDailyLossPct: 6,
  minPrice: 1,
  maxPrice: 10,
  minRelativeVolume: 3,
  maxFloatM: 20,
  minPriceSurgePct: 5,
  minCatalystScore: 30,
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
