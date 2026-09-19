import { getEnv } from "./env";

// BlackBird talks to exactly ONE hard-coded Nano RPC endpoint so environment
// variables cannot redirect calls to a different node. There is no fallback:
// rpc.nano-gpt.com was removed 2026-09-11 (expired TLS certificate — it answered
// nothing while masking the real error from nano.to). If rpc.nano.to is down the
// app shows a maintenance screen rather than silently rerouting user traffic.
// Local/backend proof-of-work remains the work fallback.
const NANO_RPC_ENDPOINT = "https://rpc.nano.to";

const DEFAULT_TIMEOUT_MS = 30_000;

export type NanoRpcResponse<T = unknown> =
  | { error: string }
  | T;

/** A real answer from a responsive endpoint (e.g. "Account not found") —
 * never a reason to fail over. */
class SemanticError extends Error {}

/** rpc.nano.to rejected our credential. It answers with HTTP 200 and
 * {"error":"Invalid API Key."}, which otherwise reads as a SemanticError and
 * fails the call outright. The node itself is healthy and its keyless tier
 * serves every read we make, so the right move is to retry the SAME endpoint
 * without the key. */
class AuthError extends Error {}

function isAuthErrorMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("invalid api key") ||
    m.includes("invalid key") ||
    m.includes("unauthorized")
  );
}

/** Latched once nano.to rejects the key so later calls skip the doomed
 * round-trip. Read by /api/greenlight to surface a degraded (not broken) tier. */
let keyRejected = false;

export function isRpcKeyRejected(): boolean {
  return keyRejected;
}

async function callEndpoint<T>(
  endpoint: string,
  action: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  withKey = true
): Promise<T> {
  const env = getEnv();
  // The API key belongs to rpc.nano.to ONLY — never sent to the fallback, and
  // never again once nano.to has rejected it.
  const useKey =
    endpoint === NANO_RPC_ENDPOINT && withKey && !keyRejected && !!env.NANO_RPC_KEY;
  const body = useKey
    ? { action, ...params, key: env.NANO_RPC_KEY }
    : { action, ...params };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(useKey ? { Authorization: env.NANO_RPC_KEY } : {}),
        "User-Agent": "BlackBird-web/1.0",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${endpoint}`);
    }

    const data = (await response.json()) as NanoRpcResponse<T>;

    if (data && typeof data === "object" && "error" in data) {
      const message = String(data.error);
      if (useKey && isAuthErrorMessage(message)) {
        throw new AuthError(message);
      }
      throw new SemanticError(`Nano RPC error: ${message}`);
    }

    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function nanoRpcCall<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  try {
    return await callEndpoint<T>(NANO_RPC_ENDPOINT, action, params, timeoutMs);
  } catch (err) {
    if (err instanceof AuthError) {
      // Same endpoint, keyless. Latch so the next call goes straight there.
      keyRejected = true;
      console.warn(
        `nano-rpc: rpc.nano.to rejected NANO_RPC_KEY (${err.message}); ` +
          "continuing keyless. Renew the key to restore the paid tier."
      );
      return await callEndpoint<T>(
        NANO_RPC_ENDPOINT,
        action,
        params,
        timeoutMs,
        false
      );
    }
    if (err instanceof SemanticError) throw new Error(err.message);
    // No fallback node by design: surface the failure so the caller (and the
    // maintenance screen) can react to a real rpc.nano.to outage.
    throw err;
  }
}

export async function getAccountBalance(account: string) {
  const data = await nanoRpcCall<{
    balance?: string;
    pending?: string;
  }>("account_balance", { account });
  return {
    balance: data.balance ?? "0",
    pending: data.pending ?? "0",
  };
}

export async function getAccountInfo(account: string) {
  return nanoRpcCall<{
    frontier?: string;
    open_block?: string;
    representative?: string;
    balance?: string;
    modified_timestamp?: string;
    block_count?: string;
  }>("account_info", {
    account,
    representative: "true",
  });
}

export async function getPendingBlocks(account: string) {
  return nanoRpcCall<{
    blocks?: Record<string, { amount: string; source: string }>;
  }>("pending", {
    account,
    count: 20,
    source: true,
    include_active: true,
  });
}
