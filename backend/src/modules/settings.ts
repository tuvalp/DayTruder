import EventEmitter from 'events';

export interface AppSettings {
  // Risk
  maxRiskPerTradePct: number;
  stopLossPct: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  // Scanner
  minPrice: number;
  maxPrice: number;
  minRelativeVolume: number;
  maxFloatM: number;
  minPriceSurgePct: number;
}

const DEFAULTS: AppSettings = {
  maxRiskPerTradePct: 1.5,
  stopLossPct: 4,
  maxOpenPositions: 5,
  maxDailyLossPct: 6,
  minPrice: 1,
  maxPrice: 10,
  minRelativeVolume: 3,
  maxFloatM: 20,
  minPriceSurgePct: 5,
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
