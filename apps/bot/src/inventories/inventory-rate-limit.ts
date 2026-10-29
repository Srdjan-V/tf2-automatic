import type { BottleneckOptions } from 'bottleneck';
import Redis from 'ioredis';
import { calculateBackoff } from '@tf2-automatic/utils';

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
): BottleneckOptions {
  return { maxConcurrent: 1, minTime: settings.minTime };
}

/**
 * Steam keeps a rate limited IP blocked for minutes, so short retries only
 * extend the block. Each failure doubles the wait from 30s up to 3 minutes.
 */
export function backoffDelay(attempts: number): number {
  // No jitter: every bot on the key reads the same stored backoff
  return calculateBackoff(attempts, 'exponential', 30000, 180000, 0);
}

/** Backoff after failed inventory requests */
export interface Backoff {
  /** Milliseconds until requests are allowed again, if positive */
  remaining(): Promise<number>;
  increase(): Promise<void>;
  /**
   * One success steps the backoff down one level, it does not reset it. The
   * next request waits gap milliseconds, the minimum time after this one
   */
  decrease(gap: number): Promise<void>;
}

export function localBackoff(): Backoff {
  let attempts = 0;
  let attemptAt = 0;

  return {
    remaining: async () => attemptAt - Date.now(),
    increase: async () => {
      attempts++;
      attemptAt = Date.now() + backoffDelay(attempts);
    },
    decrease: async (gap) => {
      attempts = Math.max(0, attempts - 1);
      attemptAt = Date.now() + gap;
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
      await redis.set(blockedKey, '1', 'PX', backoffDelay(attempts));
    },
    decrease: async (gap) => {
      if ((await redis.decr(attemptsKey)) <= 0) {
        await redis.del(attemptsKey);
      }
      if (gap > 0) {
        await redis.set(blockedKey, '1', 'PX', gap);
      }
    },
  };
}
