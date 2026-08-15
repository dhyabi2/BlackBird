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
    root?: string;
    denomination?: string;
    block_height?: number;
    guardian_count?: number;
    active?: boolean;
  }>("/api/status");
}

export async function submitDeposit(body: {
  account: string;
  amountRaw: string;
  commitment: string;
}) {
  return velaFetch("/api/deposit", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function submitWithdrawal(body: {
  nullifier: string;
  proof: unknown;
  publicSignals: string[];
  destination: string;
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
