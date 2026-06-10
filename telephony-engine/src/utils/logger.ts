import { config } from 'dotenv';
config();

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: number = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? 1;

function log(level: LogLevel, tag: string, message: string, ...args: unknown[]): void {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  if (level === 'error') {
    console.error(prefix, message, ...args);
  } else if (level === 'warn') {
    console.warn(prefix, message, ...args);
  } else {
    console.log(prefix, message, ...args);
  }
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => log('debug', tag, msg, ...args),
    info:  (msg: string, ...args: unknown[]) => log('info',  tag, msg, ...args),
    warn:  (msg: string, ...args: unknown[]) => log('warn',  tag, msg, ...args),
    error: (msg: string, ...args: unknown[]) => log('error', tag, msg, ...args),
  };
}
