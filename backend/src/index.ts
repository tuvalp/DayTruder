import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { logger } from './utils/logger';
import { AlphaAgent } from './modules/agent';
import type { AgentLogEntry, PortfolioSnapshot, PerformanceDataPoint } from './types';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── Agent ────────────────────────────────────────────────────────────────────
const agent = new AlphaAgent();

// Pipe agent log events through to connected clients
logger.setEmitter((entry: AgentLogEntry) => io.emit('log', entry));

agent.on('portfolio', (snapshot: PortfolioSnapshot) => io.emit('portfolio', snapshot));
agent.on('performance', (history: PerformanceDataPoint[]) => io.emit('performance', history));
agent.on('state', (state: string) => io.emit('agentState', state));
agent.on('trade', (position: unknown) => io.emit('trade', position));

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, state: agent.getState() }));

app.post('/agent/start', (_req, res) => {
  agent.start().catch((err) => logger.error('system', String(err)));
  res.json({ ok: true });
});

app.post('/agent/pause', (_req, res) => {
  agent.pause();
  res.json({ ok: true });
});

app.get('/agent/performance', (_req, res) => {
  res.json(agent.getPerformanceHistory());
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info('system', `Dashboard connected: ${socket.id}`);

  // Send current state on connect
  socket.emit('agentState', agent.getState());
  socket.emit('performance', agent.getPerformanceHistory());

  socket.on('startAgent', () => agent.start().catch((e) => logger.error('system', String(e))));
  socket.on('pauseAgent', () => agent.pause());

  socket.on('disconnect', () =>
    logger.info('system', `Dashboard disconnected: ${socket.id}`)
  );
});

// ── Boot ──────────────────────────────────────────────────────────────────────
httpServer.listen(config.PORT, () => {
  logger.info('system', `AlphaAgent backend listening on port ${config.PORT}`);
  if (config.NODE_ENV === 'production') {
    agent.start().catch((err) => {
      logger.error('system', `Failed to auto-start agent: ${err}`);
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  agent.pause();
  httpServer.close(() => process.exit(0));
});
