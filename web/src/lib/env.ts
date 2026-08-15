import { z } from "zod";

const envSchema = z.object({
  NANO_RPC_ENDPOINT: z.string().url().default("https://rpc.nano.to"),
  NANO_RPC_KEY: z.string().min(1, "NANO_RPC_KEY is required"),
  VELA_BACKEND_URL: z.string().url(),
  VELA_BACKEND_API_KEY: z.string().min(1, "VELA_BACKEND_API_KEY is required"),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  NEXT_PUBLIC_APP_NAME: z.string().default("VELA v2"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;

  try {
    cachedEnv = envSchema.parse(process.env);
    return cachedEnv;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment variables: ${issues}`);
    }
    throw err;
  }
}

export function hasRateLimitConfig(): boolean {
  const env = getEnv();
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}
