import { validateWork } from "./work";

// nano-pow picks the fastest available backend at runtime (WebGPU → WebGL2 →
// WASM). The module is browser-only, so it is loaded lazily on first use.
let nanoPowModule: Promise<typeof import("nano-pow")> | null = null;

// WASM-only machines can take minutes at send difficulty; give up after this
// long and let the caller fall back to the remote work API. nano-pow keeps
// computing after we stop waiting and caches the result per hash, so a retry
// with a longer timeout often returns instantly.
const DEFAULT_LOCAL_WORK_TIMEOUT_MS = 45000;

function reverseHex(hex: string): string {
  return hex.match(/.{2}/g)!.reverse().join("");
}

/**
 * Generate proof-of-work locally in the browser (GPU when available).
 *
 * Returns a validated 16-char hex work string, or null if local generation is
 * unavailable, times out, or produces work that fails validation.
 */
export async function generateLocalWork(
  hash: string,
  threshold: string,
  timeoutMs: number = DEFAULT_LOCAL_WORK_TIMEOUT_MS
): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return null;
  if (!/^[0-9a-fA-F]{16}$/.test(threshold)) return null;

  try {
    nanoPowModule ??= import("nano-pow");
    const { NanoPow } = await nanoPowModule;

    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs)
    );
    const result = await Promise.race([
      NanoPow.work_generate(hash, {
        difficulty: BigInt("0x" + threshold.toLowerCase()),
      }),
      timeout,
    ]);

    if (!result || "error" in result || !result.work) return null;

    const work = result.work.toLowerCase();
    if (validateWork(work, hash, threshold)) return work;
    // Defensive: accept the opposite byte order if that is what validates.
    const reversed = reverseHex(work);
    if (validateWork(reversed, hash, threshold)) return reversed;
    return null;
  } catch {
    return null;
  }
}
