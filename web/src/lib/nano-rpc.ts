import { getEnv } from "./env";

export type NanoRpcResponse<T = unknown> =
  | { error: string }
  | T;

export async function nanoRpcCall<T = unknown>(
  action: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const env = getEnv();
  const endpoint = env.NANO_RPC_ENDPOINT;
  const body = { action, ...params, key: env.NANO_RPC_KEY };

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
