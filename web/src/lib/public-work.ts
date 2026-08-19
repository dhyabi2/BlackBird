import { validateWork } from "./work";

// Public Nano RPCs that at least occasionally serve valid work_generate.
// Surveyed 22 known public endpoints (2026-08): most are dead, refuse
// work_generate, or return invalid nonces. These two have working-but-flaky
// upstream work servers, so they are queried as last-resort fallbacks
// (behind the primary rpc.nano.to GPU service) and every response is
// validated before use.
const DEFAULT_PUBLIC_WORK_URLS = [
  "https://nanoslo.0x.no/proxy",
  "https://rainstorm.city/api",
];

function publicWorkUrls(): string[] {
  const env = process.env.PUBLIC_WORK_URLS;
  if (env) {
    return env
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
  }
  return DEFAULT_PUBLIC_WORK_URLS;
}

async function requestWork(
  url: string,
  hash: string,
  difficulty: string,
  signal: AbortSignal
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "work_generate", hash, difficulty }),
      cache: "no-store",
      signal,
    });
    const data = (await res.json().catch(() => null)) as { work?: string } | null;
    const work = data?.work;
    if (work && /^[0-9a-fA-F]{16}$/.test(work) && validateWork(work, hash, difficulty)) {
      return work;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Query all public work endpoints in parallel; resolve with the first
 * response that passes local proof-of-work validation, or null when none do
 * within timeoutMs.
 */
export async function getPublicWork(
  hash: string,
  difficulty: string,
  timeoutMs = 28000
): Promise<{ work: string; source: string } | null> {
  const urls = publicWorkUrls();
  if (urls.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await new Promise((resolve) => {
      let unresolved = urls.length;
      for (const url of urls) {
        requestWork(url, hash, difficulty, controller.signal).then((work) => {
          if (work) {
            controller.abort(); // cancel the slower requests
            resolve({ work, source: url });
          } else if (--unresolved === 0) {
            resolve(null);
          }
        });
      }
    });
  } finally {
    clearTimeout(timer);
  }
}
