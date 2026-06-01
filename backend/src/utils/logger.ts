import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import type { AgentLogEntry } from '../types';

const winstonLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

type LogEmitter = (entry: AgentLogEntry) => void;

class AgentLogger {
  private emitter: LogEmitter | null = null;

  setEmitter(fn: LogEmitter) {
    this.emitter = fn;
  }

  private emit(entry: AgentLogEntry) {
    winstonLogger.log(entry.level === 'trade' || entry.level === 'success' ? 'info' : entry.level, `[${entry.module.toUpperCase()}] ${entry.message}`);
    this.emitter?.(entry);
  }

  log(
    level: AgentLogEntry['level'],
    module: AgentLogEntry['module'],
    message: string,
    data?: Record<string, unknown>
  ) {
    this.emit({ id: uuidv4(), level, module, message, data, timestamp: Date.now() });
  }

  info(module: AgentLogEntry['module'], msg: string, data?: Record<string, unknown>) {
    this.log('info', module, msg, data);
  }
  warn(module: AgentLogEntry['module'], msg: string, data?: Record<string, unknown>) {
    this.log('warn', module, msg, data);
  }
  error(module: AgentLogEntry['module'], msg: string, data?: Record<string, unknown>) {
    this.log('error', module, msg, data);
  }
  success(module: AgentLogEntry['module'], msg: string, data?: Record<string, unknown>) {
    this.log('success', module, msg, data);
  }
  trade(module: AgentLogEntry['module'], msg: string, data?: Record<string, unknown>) {
    this.log('trade', module, msg, data);
  }
}

export const logger = new AgentLogger();
