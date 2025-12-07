const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function logMessage(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const color = { info: colors.green, warn: colors.yellow, error: colors.red }[level];
  const output = `${colors.gray}${timestamp}${colors.reset} ${color}[${level}]${colors.reset}`;
  if (level === 'error') {
    console.error(output, ...args);
  } else {
    console.log(output, ...args);
  }
}

function logRequest(method: string, path: string, status: number, duration: number): void {
  const statusColor = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;
  const line = `${colors.cyan}[${method}]${colors.reset} - ${path} ${statusColor}${status}${colors.reset} ${colors.gray}${duration}ms${colors.reset}`;
  if (status >= 400) {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (...args: unknown[]) => logMessage('info', ...args),
  warn: (...args: unknown[]) => logMessage('warn', ...args),
  error: (...args: unknown[]) => logMessage('error', ...args),
  request: logRequest
};

export default log;
