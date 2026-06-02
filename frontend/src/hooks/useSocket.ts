import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  AgentLogEntry,
  AgentState,
  AppSettings,
  PortfolioSnapshot,
  PerformanceDataPoint,
  WatchlistEntry,
} from '../types';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:4000';
const MAX_LOGS = 500;

const DEFAULT_SETTINGS: AppSettings = {
  maxRiskPerTradePct: 1.5,
  stopLossPct: 4,
  maxOpenPositions: 5,
  maxDailyLossPct: 6,
  minPrice: 1,
  maxPrice: 10,
  minRelativeVolume: 3,
  maxFloatM: 20,
  minPriceSurgePct: 5,
  minCatalystScore: 30,
};

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null);
  const [performance, setPerformance] = useState<PerformanceDataPoint[]>([]);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);

  useEffect(() => {
    const socket = io(BACKEND_URL, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('agentState', (s: AgentState) => setAgentState(s));
    socket.on('portfolio', (p: PortfolioSnapshot) => setPortfolio(p));
    socket.on('performance', (h: PerformanceDataPoint[]) => setPerformance(h));
    socket.on('settings', (s: AppSettings) => setSettings(s));
    socket.on('watchlist', (s: WatchlistEntry[]) => setWatchlist(s));
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

  return { connected, agentState, portfolio, performance, logs, settings, watchlist, startAgent, pauseAgent, updateSettings };
}
