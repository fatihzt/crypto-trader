const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export const logger = {
  info(module: string, message: string, data?: Record<string, unknown>) {
    const prefix = `${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.cyan}[${module}]${COLORS.reset}`;
    console.log(`${prefix} ${message}`, data ? JSON.stringify(data) : '');
  },

  warn(module: string, message: string, data?: Record<string, unknown>) {
    const prefix = `${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.yellow}⚠ [${module}]${COLORS.reset}`;
    console.warn(`${prefix} ${message}`, data ? JSON.stringify(data) : '');
  },

  error(module: string, message: string, error?: unknown) {
    const prefix = `${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.red}✗ [${module}]${COLORS.reset}`;
    const errMsg = error instanceof Error ? error.message : String(error ?? '');
    console.error(`${prefix} ${message}`, errMsg);
  },

  trade(action: string, symbol: string, details: Record<string, unknown>) {
    const prefix = `${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.green}💰 [TRADE]${COLORS.reset}`;
    console.log(`${prefix} ${action} ${symbol}`, JSON.stringify(details));
  },

  signal(symbol: string, direction: string, details: Record<string, unknown>) {
    const prefix = `${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.magenta}📊 [SIGNAL]${COLORS.reset}`;
    console.log(`${prefix} ${direction} ${symbol}`, JSON.stringify(details));
  },

  regime(symbol: string, decision: string, details: Record<string, unknown>) {
    const prefix = `${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.blue}🌍 [REGIME]${COLORS.reset}`;
    console.log(`${prefix} ${symbol} → ${decision}`, JSON.stringify(details));
  },

  llm(action: string, details: Record<string, unknown>) {
    const prefix = `${COLORS.gray}${timestamp()}${COLORS.reset} ${COLORS.yellow}🤖 [LLM]${COLORS.reset}`;
    console.log(`${prefix} ${action}`, JSON.stringify(details));
  },
};
