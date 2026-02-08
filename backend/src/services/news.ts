// ============================================
// NEWS SERVICE - CryptoPanic + Fear & Greed
// ============================================

import axios from 'axios';
import { NewsItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

interface CryptoPanicPost {
  title: string;
  url: string;
  source: {
    title: string;
  };
  published_at: string;
  votes?: {
    positive: number;
    negative: number;
    important: number;
  };
}

interface CryptoPanicResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: CryptoPanicPost[];
}

interface FearGreedResponse {
  name: string;
  data: Array<{
    value: string;
    value_classification: string;
    timestamp: string;
    time_until_update?: string;
  }>;
}

interface CachedNews {
  data: NewsItem[];
  timestamp: number;
}

interface CachedFearGreed {
  data: { value: number; label: string };
  timestamp: number;
}

export class NewsService {
  private newsCache = new Map<string, CachedNews>();
  private fearGreedCache: CachedFearGreed | null = null;
  private readonly NEWS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly FEAR_GREED_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  private readonly CRYPTOPANIC_BASE_URL = 'https://cryptopanic.com/api/free/v1/posts/';
  private readonly FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1';

  /**
   * Fetch latest news for a given symbol
   * Returns cached data if fresh (< 5 min old)
   */
  async getLatestNews(symbol: string): Promise<NewsItem[]> {
    const cacheKey = symbol.toUpperCase();
    const cached = this.newsCache.get(cacheKey);

    // Return cache if fresh
    if (cached && Date.now() - cached.timestamp < this.NEWS_CACHE_TTL) {
      logger.info('NewsService', `Using cached news for ${symbol}`);
      return cached.data;
    }

    // No API key? Return empty (graceful degradation)
    if (!env.CRYPTOPANIC_API_KEY) {
      logger.warn('NewsService', 'CRYPTOPANIC_API_KEY not configured, returning empty news');
      return [];
    }

    try {
      // Map symbol to currency code (e.g., BTCUSDT → BTC)
      const currency = symbol.replace('USDT', '').toUpperCase();

      const response = await axios.get<CryptoPanicResponse>(this.CRYPTOPANIC_BASE_URL, {
        params: {
          auth_token: env.CRYPTOPANIC_API_KEY,
          currencies: currency,
          filter: 'important',
          public: 'true',
        },
        timeout: 10000,
      });

      const newsItems: NewsItem[] = response.data.results.map((post) => {
        // Determine sentiment based on votes
        let sentiment: 'positive' | 'negative' | 'neutral' = 'neutral';
        if (post.votes) {
          const { positive, negative } = post.votes;
          if (positive > negative * 1.5) sentiment = 'positive';
          else if (negative > positive * 1.5) sentiment = 'negative';
        }

        return {
          title: post.title,
          source: post.source.title,
          url: post.url,
          publishedAt: post.published_at,
          sentiment,
        };
      });

      // Cache the results
      this.newsCache.set(cacheKey, {
        data: newsItems,
        timestamp: Date.now(),
      });

      logger.info('NewsService', `Fetched ${newsItems.length} news items for ${symbol}`);
      return newsItems;
    } catch (error) {
      logger.error('NewsService', `Failed to fetch news for ${symbol}`, error);

      // Return cached data if available, even if expired
      if (cached) {
        logger.warn('NewsService', `Using stale cache for ${symbol}`);
        return cached.data;
      }

      // Otherwise return empty
      return [];
    }
  }

  /**
   * Fetch current Fear & Greed Index
   * Returns cached data if fresh (< 30 min old)
   */
  async getFearGreedIndex(): Promise<{ value: number; label: string }> {
    // Return cache if fresh
    if (this.fearGreedCache && Date.now() - this.fearGreedCache.timestamp < this.FEAR_GREED_CACHE_TTL) {
      logger.info('NewsService', 'Using cached Fear & Greed Index');
      return this.fearGreedCache.data;
    }

    try {
      const response = await axios.get<FearGreedResponse>(this.FEAR_GREED_URL, {
        timeout: 10000,
      });

      const latestData = response.data.data[0];
      const value = parseInt(latestData.value, 10);
      const label = latestData.value_classification;

      const result = { value, label };

      // Cache the result
      this.fearGreedCache = {
        data: result,
        timestamp: Date.now(),
      };

      logger.info('NewsService', `Fetched Fear & Greed Index: ${value} (${label})`);
      return result;
    } catch (error) {
      logger.error('NewsService', 'Failed to fetch Fear & Greed Index', error);

      // Return cached data if available, even if expired
      if (this.fearGreedCache) {
        logger.warn('NewsService', 'Using stale Fear & Greed cache');
        return this.fearGreedCache.data;
      }

      // Otherwise return neutral default
      return { value: 50, label: 'Neutral' };
    }
  }
}
