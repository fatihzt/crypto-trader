// ============================================
// API ROUTES - Fastify REST API
// ============================================

import { FastifyInstance, FastifyRequest } from 'fastify';
import { TradingEngine } from '../services/engine.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

interface QueryParams {
  limit?: string;
}

export async function apiRoutes(fastify: FastifyInstance, engine: TradingEngine): Promise<void> {
  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // GET /api/state - Full engine state
  fastify.get('/api/state', async () => {
    try {
      const state = engine.getState();
      return state;
    } catch (error) {
      logger.error('API', 'Failed to get engine state', error);
      throw error;
    }
  });

  // GET /api/portfolio - Portfolio state
  fastify.get('/api/portfolio', async () => {
    try {
      const state = engine.getState();
      return state.portfolio;
    } catch (error) {
      logger.error('API', 'Failed to get portfolio state', error);
      throw error;
    }
  });

  // GET /api/trades - Closed trades (query: ?limit=50)
  fastify.get<{ Querystring: QueryParams }>('/api/trades', async (request: FastifyRequest<{ Querystring: QueryParams }>) => {
    try {
      const limit = parseInt(request.query.limit || '50', 10);

      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .order('exit_time', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('API', 'Failed to get closed trades', error);
      throw error;
    }
  });

  // GET /api/trades/open - Open positions
  fastify.get('/api/trades/open', async () => {
    try {
      const state = engine.getState();
      return state.portfolio.positions;
    } catch (error) {
      logger.error('API', 'Failed to get open positions', error);
      throw error;
    }
  });

  // GET /api/signals - Recent signals (from supabase, ?limit=20)
  fastify.get<{ Querystring: QueryParams }>('/api/signals', async (request: FastifyRequest<{ Querystring: QueryParams }>) => {
    try {
      const limit = parseInt(request.query.limit || '20', 10);

      const { data, error } = await supabase
        .from('signals')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('API', 'Failed to get signals', error);
      throw error;
    }
  });

  // GET /api/regime - Current regime for all symbols
  fastify.get('/api/regime', async () => {
    try {
      const state = engine.getState();
      return state.regimes;
    } catch (error) {
      logger.error('API', 'Failed to get regime state', error);
      throw error;
    }
  });

  // GET /api/decisions - LLM decisions (from supabase, ?limit=20)
  fastify.get<{ Querystring: QueryParams }>('/api/decisions', async (request: FastifyRequest<{ Querystring: QueryParams }>) => {
    try {
      const limit = parseInt(request.query.limit || '20', 10);

      const { data, error } = await supabase
        .from('llm_decisions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('API', 'Failed to get LLM decisions', error);
      throw error;
    }
  });

  logger.info('API', 'API routes registered');
}
