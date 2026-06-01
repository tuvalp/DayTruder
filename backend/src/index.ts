import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { logger } from './utils/logger';
import { AlphaAgent } from './modules/agent';
import { settingsStore } from './modules/settings';
import type { AgentLogEntry, PortfolioSnapshot, PerformanceDataPoint } from './types';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const agent = new AlphaAgent();

logger.setEmitter((entry: AgentLogEntry) => io.emit('log', entry));
agent.on('portfolio', (s: PortfolioSnapshot) => io.emit('portfolio', s));
agent.on('performance', (h: PerformanceDataPoint[]) => io.emit('performance', h));
agent.on('state', (s: string) => io.emit('agentState', s));
agent.on('trade', (p: unknown) => io.emit('trade', p));
agent.on('watchlist', (symbols: string[]) => io.emit('watchlist', symbols));

// Broadcast settings changes to all connected dashboards
settingsStore.on('change', (s) => io.emit('settings', s));

// ── REST ──────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, state: agent.getState() }));

app.post('/agent/start', (_req, res) => {
  agent.start().catch((e) => logger.error('system', String(e)));
  res.json({ ok: true });
});
app.post('/agent/pause', (_req, res) => { agent.pause(); res.json({ ok: true }); });
app.get('/agent/performance', (_req, res) => res.json(agent.getPerformanceHistory()));

app.get('/settings', (_req, res) => res.json(settingsStore.get()));
app.patch('/settings', (req, res) => {
  const updated = settingsStore.update(req.body);
  logger.info('system', 'Settings updated via UI', updated as unknown as Record<string, unknown>);
  res.json(updated);
});
app.post('/settings/reset', (_req, res) => res.json(settingsStore.reset()));

// ── WebSocket ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info('system', `Dashboard connected: ${socket.id}`);
  socket.emit('agentState', agent.getState());
  socket.emit('settings', settingsStore.get());
  socket.emit('performance', agent.getPerformanceHistory());

  socket.on('startAgent', () => agent.start().catch((e) => logger.error('system', String(e))));
  socket.on('pauseAgent', () => agent.pause());
  socket.on('updateSettings', (patch: Record<string, number>) => {
    const updated = settingsStore.update(patch);
    io.emit('settings', updated);
  });

  socket.on('disconnect', () => logger.info('system', `Dashboard disconnected: ${socket.id}`));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
httpServer.listen(config.PORT, () => {
  logger.info('system', `AlphaAgent backend listening on port ${config.PORT}`);
  if (config.NODE_ENV === 'production') {
    agent.start().catch((e) => logger.error('system', `Auto-start failed: ${e}`));
  }
});

process.on('SIGTERM', () => { agent.pause(); httpServer.close(() => process.exit(0)); });
