import { getEnv } from "./env";

const SEND_DIFFICULTY = "fffffff800000000";

async function backendFetch(path: string, body: unknown, timeoutMs: number) {
  const env = getEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.VELA_BACKEND_URL.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VELA-API-Key": env.VELA_BACKEND_API_KEY,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    return (await res.json().catch(() => null)) as { work?: string; error?: string } | null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the backend work service for cached/computed work. Returns null when the
 * work is not ready (the request also queues it for background computation).
 */
export async function getServerWork(
  hash: string,
  difficulty: string,
  timeoutMs = 25000
): Promise<string | null> {
  try {
    const data = await backendFetch("/api/work", { hash, difficulty }, timeoutMs);
    return data?.work && /^[0-9a-fA-F]{16}$/.test(data.work) ? data.work : null;
  } catch {
    return null;
  }
}

/** Fire-and-forget: queue background work computation for a known future root. */
export async function warmServerWork(hash: string, difficulty = SEND_DIFFICULTY): Promise<void> {
  try {
    await backendFetch("/api/work/warm", { hash, difficulty }, 5000);
  } catch {
    // best-effort
  }
}
