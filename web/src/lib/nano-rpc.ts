import { getEnv } from "./env";

export type NanoRpcResponse<T = unknown> =
  | { error: string }
  | T;

const FALLBACK_ENDPOINTS = [
  "https://proxy.nanos.cc/proxy",
  "https://node.somenano.com/proxy",
  "https://rainstorm.city/api",
];

export async function nanoRpcCall<T = unknown>(
  action: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const env = getEnv();
  const endpoints = [env.NANO_RPC_ENDPOINT, ...FALLBACK_ENDPOINTS];
  const body = { action, ...params, key: env.NANO_RPC_KEY };

  let lastError: Error | undefined;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: env.NANO_RPC_KEY,
          "User-Agent": "VELA-web/1.0",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${endpoint}`);
      }

      const data = (await response.json()) as NanoRpcResponse<T>;

      if (data && typeof data === "object" && "error" in data) {
        throw new Error(`Nano RPC error: ${data.error}`);
      }

      return data as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("All Nano RPC endpoints failed");
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
