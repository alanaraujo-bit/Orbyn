import { redact } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw in LEVEL_WEIGHT ? (raw as LogLevel) : 'info';
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, scope: string, bindings: Record<string, unknown>, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel()]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...(redact({ ...bindings, ...fields }) as Record<string, unknown>),
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') {
    console.error(line);
    return;
  }
  console.log(line);
}

export function createLogger(scope: string, bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (message, fields) => emit('debug', scope, bindings, message, fields),
    info: (message, fields) => emit('info', scope, bindings, message, fields),
    warn: (message, fields) => emit('warn', scope, bindings, message, fields),
    error: (message, fields) => emit('error', scope, bindings, message, fields),
    child: (extra) => createLogger(scope, { ...bindings, ...extra }),
  };
}

export const logger = createLogger('app');
