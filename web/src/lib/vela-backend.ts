import { getEnv } from "./env";
import { ApiError } from "./errors";

async function velaFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const env = getEnv();
  const url = `${env.VELA_BACKEND_URL.replace(/\/$/, "")}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-VELA-API-Key": env.VELA_BACKEND_API_KEY,
      ...(options.headers || {}),
    },
    cache: "no-store",
  });

  const data = (await response.json().catch(() => ({
    error: `Backend returned status ${response.status}`,
  }))) as { error?: string } | T;

  if (!response.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `Backend error ${response.status}`;
    throw new ApiError(response.status, msg, "BACKEND_ERROR");
  }

  return data as T;
}

export async function getPoolStatus() {
  return velaFetch<{
    status?: string;
    epoch?: number;
    roots?: { denomination: string; root: string | null }[];
    pool_pubkey?: string;
  }>("/api/status");
}

export async function getFeeConfig() {
  return velaFetch<{
    fee_bps?: number;
    fee_percent?: number;
  }>("/api/fee");
}

export async function getPoolAddress(denomination: number | string) {
  return velaFetch<{
    denomination?: string;
    pool_pubkey?: string;
  }>(`/api/pool_address/${denomination}`);
}

export async function submitDeposit(body: {
  deposit_hash: string;
  commit_hash: string;
}) {
  return velaFetch("/api/deposit", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function submitWithdrawal(body: {
  destination: string;
  epoch: number;
  denomination: number | string;
  nullifier: string;
  proof: unknown;
  publicSignals: string[];
}) {
  return velaFetch("/api/withdraw", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function requestProof(body: {
  n: string;
  t: string;
  P_w: string;
  nullifier: string;
  denomination: number | string;
  epoch: number;
  leaf_index?: number;
}) {
  return velaFetch<{
    proof?: unknown;
    publicSignals?: string[];
  }>("/api/prove", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getDepositStatus(query: {
  deposit_hash?: string;
  commit_hash?: string;
  commitment?: string;
}) {
  const params = new URLSearchParams();
  if (query.deposit_hash) params.set("deposit_hash", query.deposit_hash);
  if (query.commit_hash) params.set("commit_hash", query.commit_hash);
  if (query.commitment) params.set("commitment", query.commitment);
  return velaFetch<{
    indexed: boolean;
    commitment?: string;
    epoch?: number;
    denomination?: number;
    root?: string | null;
    leaf_index?: number;
  }>(`/api/deposit_status?${params.toString()}`, {
    method: "GET",
  });
}
