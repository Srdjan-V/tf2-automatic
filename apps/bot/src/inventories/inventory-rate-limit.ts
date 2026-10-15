import Bottleneck from 'bottleneck';
import Redis from 'ioredis';
import { calculateBackoff } from '@tf2-automatic/queue';

export interface RateLimitSettings {
  minTime: number;
}

/**
 * Bots sharing a rate limit key may be configured differently; the shared
 * limiter uses the strictest of them, the largest gap between requests.
 */
export function strictestSettings(all: RateLimitSettings[]): RateLimitSettings {
  return { minTime: Math.max(...all.map((settings) => settings.minTime)) };
}

export function toBottleneckSettings(
  settings: RateLimitSettings,
): Bottleneck.ConstructorOptions {
  return { maxConcurrent: 1, minTime: settings.minTime };
}

/** Backoff after failed inventory requests */
export interface Backoff {
  /** Milliseconds to wait before the next request, if positive */
  remaining(): Promise<number>;
  increase(): Promise<void>;
  reset(): Promise<void>;
}

export function localBackoff(): Backoff {
  let attempts = 0;
  let attemptAt = 0;

  return {
    remaining: async () => attemptAt - Date.now(),
    increase: async () => {
      attempts++;
      attemptAt = Date.now() + calculateBackoff(attempts);
    },
    reset: async () => {
      attempts = 0;
    },
  };
}

const ATTEMPTS_TTL_SECONDS = 60 * 60;

/** Backoff shared by every bot on the same rate limit key */
export function redisBackoff(redis: Redis, key: string): Backoff {
  const attemptsKey = key + ':attempts';
  const blockedKey = key + ':blocked';

  return {
    remaining: () => redis.pttl(blockedKey),
    increase: async () => {
      const attempts = await redis.incr(attemptsKey);
      await redis.expire(attemptsKey, ATTEMPTS_TTL_SECONDS);
      await redis.set(blockedKey, '1', 'PX', calculateBackoff(attempts));
    },
    reset: async () => {
      await redis.del(attemptsKey);
    },
  };
}
