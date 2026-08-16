import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getEnv, hasRateLimitConfig } from "./env";

let ratelimit: Ratelimit | null = null;

// In-memory fallback when Upstash is not configured. Not global across Vercel
// instances, but still prevents a single instance from being overwhelmed.
const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 20;
const memoryBuckets = new Map<string, number[]>();

function cleanupMemoryBucket(identifier: string, now: number) {
  const bucket = memoryBuckets.get(identifier) || [];
  const valid = bucket.filter((t) => now - t < WINDOW_MS);
  memoryBuckets.set(identifier, valid);
  return valid;
}

function checkMemoryRateLimit(identifier: string): { success: boolean; limit: number; remaining: number; reset: number } {
  const now = Date.now();
  const bucket = cleanupMemoryBucket(identifier, now);
  if (bucket.length >= WINDOW_LIMIT) {
    const oldest = bucket[0];
    return { success: false, limit: WINDOW_LIMIT, remaining: 0, reset: oldest + WINDOW_MS };
  }
  bucket.push(now);
  memoryBuckets.set(identifier, bucket);
  return {
    success: true,
    limit: WINDOW_LIMIT,
    remaining: Math.max(0, WINDOW_LIMIT - bucket.length),
    reset: now + WINDOW_MS,
  };
}

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
    return checkMemoryRateLimit(identifier);
  }

  const result = await limiter.limit(identifier);
  return {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
    reset: result.reset,
  };
}
