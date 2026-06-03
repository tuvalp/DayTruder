export type TradeSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type OrderStatus = 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';
export type PositionStatus = 'open' | 'closed';
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

export interface MarketTick {
  symbol: string;
  price: number;
  volume: number;
  timestamp: number;
  bid?: number;
  ask?: number;
  spread?: number;
}

export interface ScannerAlert {
  symbol: string;
  price: number;
  priceChangePct: number;      // 1-minute price change %
  volume: number;
  relativeVolume: number;      // current vol / avg vol ratio
  float: number;               // shares float in millions
  marketCap: number;
  timestamp: number;
  triggerReasons: string[];
  suggestedEntry?: number;     // support/consolidation level — best buy price
  suggestedExit?: number;      // resistance level — best sell target
  supportLevel?: number;
  resistanceLevel?: number;
}

export interface CatalystScore {
  symbol: string;
  score: number;               // 0-100
  sentiment: 'bullish' | 'bearish' | 'neutral';
  catalystType: string;        // e.g. "FDA Approval", "Earnings Beat"
  headline: string;
  reasoning: string;
  confidence: number;          // 0-1
  analyzedAt: number;
}

export interface RiskParameters {
  accountLiquidity: number;
  maxRiskPerTradePct: number;  // 1.5%
  stopLossPct: number;         // 3-5%
  takeProfitTiers: number[];   // e.g. [0.05, 0.10, 0.20]
  maxOpenPositions: number;
  maxDailyLossPct: number;
}

export interface PositionSizing {
  symbol: string;
  shares: number;
  entryPrice: number;
  stopLoss: number;
  takeProfits: number[];
  dollarRisk: number;
  positionValue: number;
}

export interface Order {
  id: string;
  brokerOrderId?: string;
  symbol: string;
  side: TradeSide;
  type: OrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  status: OrderStatus;
  filledQty?: number;
  avgFillPrice?: number;
  submittedAt: number;
  filledAt?: number;
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
  status: PositionStatus;
  openedAt: number;
  closedAt?: number;
  realizedPnl?: number;
  catalystScore: CatalystScore;
  orders: Order[];
  // Active management state
  sessionHigh?: number;      // highest price seen since entry — for trailing/reversal
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  slOrderId?: number;        // IBKR orderId of the live stop order — for modification
  tp1OrderId?: number;
  tp2OrderId?: number;
}

export interface PortfolioSnapshot {
  netLiquidity: number;
  dailyRealizedPnl: number;
  dailyUnrealizedPnl: number;
  dailyPnlPct: number;
  openPositions: Position[];
  activeRiskMultiplier: number;  // scales down sizing when losing
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
