import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getEnv, hasRateLimitConfig } from "./env";

let ratelimit: Ratelimit | null = null;

function getRateLimiter(): Ratelimit | null {
  if (!hasRateLimitConfig()) return null;
  if (ratelimit) return ratelimit;

  const redis = new Redis({
    url: getEnv().UPSTASH_REDIS_REST_URL!,
    token: getEnv().UPSTASH_REDIS_REST_TOKEN!,
  });

  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(20, "1 m"),
    analytics: true,
  });

  return ratelimit;
}

export async function checkRateLimit(
  identifier: string
): Promise<{ success: boolean; limit: number; remaining: number; reset: number }> {
  const limiter = getRateLimiter();
  if (!limiter) {
    return { success: true, limit: 0, remaining: 0, reset: 0 };
  }

  const result = await limiter.limit(identifier);
  return {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
    reset: result.reset,
  };
}
