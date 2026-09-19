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

export type E2eStatus = {
  /** true only when the newest probe passed AND is fresh; null = never run. */
  ok: boolean | null;
  state: "ok" | "failing" | "stale" | "unknown";
  checked_at?: string | null;
  age_seconds?: number | null;
  duration_ms?: number | null;
  failed_step?: string | null;
  error?: string | null;
  epoch?: number | null;
  denomination_nano?: string | null;
  steps?: { name: string; ok: boolean; ms: number; error?: string }[];
  recent?: {
    checked_at: string;
    ok: boolean;
    duration_ms: number;
    failed_step: string | null;
  }[];
};

/** Result of the hourly end-to-end probe that shields and withdraws real XNO. */
export async function getE2eStatus() {
  return velaFetch<E2eStatus>("/api/e2e_status");
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

export async function submitWithdrawalBroadcast(body: {
  nullifier: string;
  block: {
    type: "state";
    account: string;
    previous: string;
    representative: string;
    balance: string;
    link: string;
    signature: string;
    work: string;
  };
}) {
  return velaFetch("/api/broadcast_withdrawal", {
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
