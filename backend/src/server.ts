// ============================================
// SERVER - Main Entry Point
// ============================================

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { TradingEngine } from './services/engine.js';
import { apiRoutes } from './routes/api.js';

async function main(): Promise<void> {
  // Create Fastify instance
  const fastify = Fastify({
    logger: false, // Use our custom logger instead
  });

  // Register CORS (support multiple origins for local + production)
  const allowedOrigins = env.FRONTEND_URL.split(',').map(u => u.trim());
  await fastify.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  // Create Trading Engine
  logger.info('Server', 'Creating trading engine...');
  const engine = new TradingEngine();

  // Register API routes
  await apiRoutes(fastify, engine);

  // Start server
  try {
    await fastify.listen({
      port: env.PORT,
      host: '0.0.0.0',
    });

    logger.info('Server', `Server listening on port ${env.PORT}`, {
      port: env.PORT,
      frontendUrl: env.FRONTEND_URL,
      nodeEnv: env.NODE_ENV,
    });
  } catch (error) {
    logger.error('Server', 'Failed to start server', error);
    process.exit(1);
  }

  // Start trading engine
  try {
    await engine.start();
  } catch (error) {
    logger.error('Server', 'Failed to start trading engine', error);
    await fastify.close();
    process.exit(1);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Server', `${signal} received, shutting down gracefully...`);

    try {
      // Stop trading engine
      await engine.stop();

      // Close server
      await fastify.close();

      logger.info('Server', 'Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Server', 'Error during shutdown', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run the server
main().catch((error) => {
  logger.error('Server', 'Fatal error', error);
  process.exit(1);
});
