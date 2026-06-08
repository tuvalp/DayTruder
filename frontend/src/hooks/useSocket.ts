import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  AgentLogEntry,
  AgentState,
  AppSettings,
  PortfolioSnapshot,
  PerformanceDataPoint,
  WatchlistEntry,
  Position,
  Order,
  TradeExecution,
  AccountPnL,
} from '../types';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000';
const MAX_LOGS = 500;

const DEFAULT_SETTINGS: AppSettings = {
  maxRiskPerTradePct: 3,
  maxPositionSizePct: 90,
  stopLossPct: 7,
  minTakeProfitPct: 20,
  commissionPerSide: 5,
  minNetProfitDollar: 10,
  maxOpenPositions: 3,
  maxDailyLossPct: 8,
  minPrice: 0.5,
  maxPrice: 20,
  minRelativeVolume: 2,
  maxFloatM: 50,
  minPriceSurgePct: 3,
  minCatalystScore: 28,
};

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected,    setConnected]    = useState(false);
  const [agentState,   setAgentState]   = useState<AgentState>('idle');
  const [portfolio,    setPortfolio]    = useState<PortfolioSnapshot | null>(null);
  const [performance,  setPerformance]  = useState<PerformanceDataPoint[]>([]);
  const [logs,         setLogs]         = useState<AgentLogEntry[]>([]);
  const [settings,     setSettings]     = useState<AppSettings>(DEFAULT_SETTINGS);
  const [watchlist,    setWatchlist]    = useState<WatchlistEntry[]>([]);
  const [positions,    setPositions]    = useState<Position[]>([]);
  const [orders,       setOrders]       = useState<Order[]>([]);
  const [executions,   setExecutions]   = useState<TradeExecution[]>([]);
  const [accountPnL,   setAccountPnL]   = useState<AccountPnL | null>(null);
  const [marketStatus, setMarketStatus] = useState<string>('unknown');

  useEffect(() => {
    const socket = io(BACKEND_URL, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect',      () => setConnected(true));
    socket.on('disconnect',   () => setConnected(false));
    socket.on('agentState',   (s: AgentState)           => setAgentState(s));
    socket.on('portfolio',    (p: PortfolioSnapshot)    => setPortfolio(p));
    socket.on('performance',  (h: PerformanceDataPoint[]) => setPerformance(h));
    socket.on('settings',     (s: AppSettings)          => setSettings(s));
    socket.on('watchlist',    (s: WatchlistEntry[])     => setWatchlist(s));
    socket.on('positions',    (s: Position[])           => setPositions(s));
    socket.on('orders',       (s: Order[])              => setOrders(s));
    socket.on('executions',   (s: TradeExecution[])     => setExecutions(s));
    socket.on('pnl',          (p: AccountPnL)           => setAccountPnL(p));
    socket.on('marketStatus', (s: string)               => setMarketStatus(s));
    socket.on('log', (entry: AgentLogEntry) =>
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
      })
    );

    return () => { socket.disconnect(); };
  }, []);

  const startAgent = useCallback(() => socketRef.current?.emit('startAgent'), []);
  const pauseAgent = useCallback(() => socketRef.current?.emit('pauseAgent'), []);
  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    socketRef.current?.emit('updateSettings', patch);
  }, []);

  return {
    connected, agentState, portfolio, performance, logs, settings,
    watchlist, positions, orders, executions, accountPnL,
    marketStatus, startAgent, pauseAgent, updateSettings,
  };
}
