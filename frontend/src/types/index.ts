export type AgentState = 'idle' | 'scanning' | 'researching' | 'executing' | 'monitoring' | 'paused';
export type SymbolStrategy = 'watching' | 'alert' | 'researching' | 'sizing' | 'positioned' | 'rejected';

export interface WatchlistEntry {
  symbol: string;
  price: number;
  changePercent: number;
  relVol: number;
  strategy: SymbolStrategy;
  updatedAt: number;
}

export interface AppSettings {
  maxRiskPerTradePct: number;
  stopLossPct: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  minPrice: number;
  maxPrice: number;
  minRelativeVolume: number;
  maxFloatM: number;
  minPriceSurgePct: number;
  minCatalystScore: number;
}

export interface CatalystScore {
  symbol: string;
  score: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  catalystType: string;
  headline: string;
  reasoning: string;
  confidence: number;
  analyzedAt: number;
}

export interface Position {
  id: string;
  symbol: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  stopLoss: number;
  takeProfits: number[];
  status: 'open' | 'closed';
  openedAt: number;
  catalystScore: CatalystScore;
}

export interface PortfolioSnapshot {
  netLiquidity: number;
  dailyRealizedPnl: number;
  dailyUnrealizedPnl: number;
  dailyPnlPct: number;
  openPositions: Position[];
  activeRiskMultiplier: number;
  snapshotAt: number;
}

export interface AgentLogEntry {
  id: string;
  level: 'info' | 'warn' | 'error' | 'success' | 'trade';
  module: 'scanner' | 'research' | 'risk' | 'execution' | 'system';
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

export interface PerformanceDataPoint {
  timestamp: number;
  equity: number;
  pnl: number;
}
