import { getEnv } from "./env";

// BlackBird talks to exactly two hard-coded Nano RPC endpoints so environment
// variables cannot redirect calls to a different node. https://rpc.nano.to is
// the PRIMARY and only keyed endpoint. https://rpc.nano-gpt.com is the SOLE
// permitted fallback (pattern shared with holdergame), used only when nano.to
// does not answer (transport failure/timeout), keyless, for its keyless tier
// (reads + process + work_validate — its keyless tier does NOT serve
// work_generate). The API key is sent to rpc.nano.to ONLY — never to the
// fallback. Local/backend proof-of-work remains the work fallback.
const NANO_RPC_ENDPOINT = "https://rpc.nano.to";
const FALLBACK_RPC_ENDPOINT = "https://rpc.nano-gpt.com";

const DEFAULT_TIMEOUT_MS = 30_000;

export type NanoRpcResponse<T = unknown> =
  | { error: string }
  | T;

/** A real answer from a responsive endpoint (e.g. "Account not found") —
 * never a reason to fail over. */
class SemanticError extends Error {}

async function callEndpoint<T>(
  endpoint: string,
  action: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const env = getEnv();
  // The API key belongs to rpc.nano.to ONLY — never sent to the fallback.
  const useKey = endpoint === NANO_RPC_ENDPOINT;
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
      throw new SemanticError(`Nano RPC error: ${data.error}`);
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
    if (err instanceof SemanticError) throw new Error(err.message);
    // Transport failure/timeout on nano.to → the one permitted fallback.
    try {
      return await callEndpoint<T>(FALLBACK_RPC_ENDPOINT, action, params, timeoutMs);
    } catch (err2) {
      if (err2 instanceof SemanticError) throw new Error(err2.message);
      throw err; // report the primary's failure
    }
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
