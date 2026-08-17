import { validateWork } from "./work";

// Proof-of-work runs in a dedicated Web Worker so the page never freezes:
// nano-pow's WebGL path performs blocking GPU readbacks that stall the main
// thread for the entire search. The worker is a singleton, so nano-pow's
// per-hash result cache is shared between warm-up and real requests.
let powWorker: Worker | null = null;
let workerBroken = false;
let requestSeq = 0;
const pendingRequests = new Map<number, (work: string | null) => void>();

// nano-pow fallback for environments where the worker cannot start.
let nanoPowModule: Promise<typeof import("nano-pow")> | null = null;

const DEFAULT_LOCAL_WORK_TIMEOUT_MS = 45000;

function getWorker(): Worker | null {
  if (typeof window === "undefined" || workerBroken) return null;
  if (powWorker) return powWorker;
  try {
    powWorker = new Worker(new URL("./work.worker.ts", import.meta.url), { type: "module" });
    powWorker.onmessage = (event: MessageEvent<{ id: number; work: string | null }>) => {
      const resolve = pendingRequests.get(event.data.id);
      if (resolve) {
        pendingRequests.delete(event.data.id);
        resolve(event.data.work ?? null);
      }
    };
    powWorker.onerror = () => {
      for (const resolve of pendingRequests.values()) resolve(null);
      pendingRequests.clear();
      powWorker?.terminate();
      powWorker = null;
      workerBroken = true;
    };
  } catch {
    powWorker = null;
    workerBroken = true;
  }
  return powWorker;
}

function reverseHex(hex: string): string {
  return hex.match(/.{2}/g)!.reverse().join("");
}

async function generateInWorker(hash: string, threshold: string): Promise<string | null> {
  const worker = getWorker();
  if (!worker) return null;
  const id = ++requestSeq;
  const result = new Promise<string | null>((resolve) => pendingRequests.set(id, resolve));
  worker.postMessage({ id, hash, difficulty: threshold });
  return result;
}

async function generateInline(hash: string, threshold: string): Promise<string | null> {
  try {
    nanoPowModule ??= import("nano-pow");
    const { NanoPow } = await nanoPowModule;
    // Force the WASM backend when running on the main thread: nano-pow's
    // WebGL path performs blocking GPU readbacks that freeze the page, while
    // WASM runs in its own workers. Slower, but never locks the UI.
    const result = await NanoPow.work_generate(hash, {
      difficulty: BigInt("0x" + threshold.toLowerCase()),
      api: "wasm",
    });
    if (!result || "error" in result || !result.work) return null;
    return result.work;
  } catch {
    return null;
  }
}

/**
 * Generate proof-of-work locally in the browser (GPU when available), off the
 * main thread. Returns a validated 16-char hex work string, or null if local
 * generation is unavailable, times out, or produces work that fails
 * validation. nano-pow keeps computing after a timeout and caches per hash,
 * so retrying with a longer timeout is cheap.
 */
export async function generateLocalWork(
  hash: string,
  threshold: string,
  timeoutMs: number = DEFAULT_LOCAL_WORK_TIMEOUT_MS
): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return null;
  if (!/^[0-9a-fA-F]{16}$/.test(threshold)) return null;

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const generated = getWorker()
    ? generateInWorker(hash, threshold)
    : generateInline(hash, threshold);
  const raw = await Promise.race([generated, timeout]);
  if (!raw) return null;

  const work = raw.toLowerCase();
  if (validateWork(work, hash, threshold)) return work;
  // Defensive: accept the opposite byte order if that is what validates.
  const reversed = reverseHex(work);
  if (validateWork(reversed, hash, threshold)) return reversed;
  return null;
}
