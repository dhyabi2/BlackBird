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
  denomination: number;
  nullifier: string;
  proof: unknown;
  publicSignals: string[];
}) {
  return velaFetch("/api/withdraw", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function requestProof(inputs: Record<string, unknown>) {
  return velaFetch<{
    proof?: unknown;
    publicSignals?: string[];
  }>("/api/prove", {
    method: "POST",
    body: JSON.stringify({ inputs }),
  });
}
