import 'dotenv/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const env = {
  // Server
  PORT: parseInt(optionalEnv('PORT', '3001'), 10),
  NODE_ENV: optionalEnv('NODE_ENV', 'development'),

  // Supabase
  SUPABASE_URL: requireEnv('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: requireEnv('SUPABASE_SERVICE_KEY'),

  // OpenAI
  OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),

  // Binance (public API, no key needed for market data)
  BINANCE_WS_URL: optionalEnv('BINANCE_WS_URL', 'wss://stream.binance.com:9443'),
  BINANCE_REST_URL: optionalEnv('BINANCE_REST_URL', 'https://api.binance.com'),

  // CryptoPanic (free tier)
  CRYPTOPANIC_API_KEY: optionalEnv('CRYPTOPANIC_API_KEY', ''),

  // Email Notifications (Resend)
  RESEND_API_KEY: optionalEnv('RESEND_API_KEY', ''),
  RESEND_FROM_EMAIL: optionalEnv('RESEND_FROM_EMAIL', 'onboarding@resend.dev'),
  NOTIFICATION_EMAIL: optionalEnv('NOTIFICATION_EMAIL', ''),

  // Frontend URL (for CORS)
  FRONTEND_URL: optionalEnv('FRONTEND_URL', 'http://localhost:3000'),
} as const;
