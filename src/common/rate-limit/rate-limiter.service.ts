import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS } from '../../infra/redis/redis.module.js';

export interface RateLimit {
  /** How many hits the window allows. */
  limit: number;
  windowS: number;
}

/**
 * Fixed-window counters in Redis (`rl:<key>`). When Redis is unreachable
 * the limiter lets requests through: a broken cache must not lock everyone
 * out of logging in.
 */
@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** 429 TOO_MANY_ATTEMPTS once `key` already reached the limit; counts nothing. */
  async assertUnder(key: string, { limit }: RateLimit): Promise<void> {
    const count = await this.safe(async () => Number((await this.redis.get(`rl:${key}`)) ?? 0), 0);
    if (count >= limit) throw tooMany(await this.retryAfter(key));
  }

  /** Counts one hit. */
  async hit(key: string, { windowS }: RateLimit): Promise<number> {
    return this.safe(async () => {
      const count = await this.redis.incr(`rl:${key}`);
      if (count === 1) await this.redis.expire(`rl:${key}`, windowS);
      return count;
    }, 0);
  }

  /** Counts one hit and answers 429 past the limit. */
  async consume(key: string, rule: RateLimit): Promise<void> {
    if ((await this.hit(key, rule)) > rule.limit) throw tooMany(await this.retryAfter(key));
  }

  async reset(key: string): Promise<void> {
    await this.safe(() => this.redis.del(`rl:${key}`), 0);
  }

  private async retryAfter(key: string): Promise<number> {
    return this.safe(async () => Math.max(await this.redis.ttl(`rl:${key}`), 1), 60);
  }

  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(`rate limiter unavailable, allowing the request: ${(err as Error).message}`);
      return fallback;
    }
  }
}

function tooMany(retryAfterS: number): HttpException {
  return new HttpException(
    { code: 'TOO_MANY_ATTEMPTS', error: `too many attempts, try again in ${Math.ceil(retryAfterS / 60)} minute(s)` },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
