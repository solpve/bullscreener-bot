/**
 * Deliberately dumb logger. It exists so that every log line goes through one
 * place we can audit: no secret material is ever passed to it, and nothing here
 * reads process.env.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return LEVELS[raw as Level] ?? LEVELS.info;
}

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold()) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, typeof extra === 'string' ? extra : JSON.stringify(extra, jsonSafe));
}

/** BigInt-safe JSON replacer. */
export function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
