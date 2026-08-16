import { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const searchParams = request.nextUrl.searchParams;
    const depositHash = searchParams.get("deposit_hash");
    const commitHash = searchParams.get("commit_hash");
    const commitment = searchParams.get("commitment");

    if ((!depositHash || !commitHash) && !commitment) {
      throw new ApiError(400, "Missing deposit_hash+commit_hash or commitment");
    }

    const limit = await checkRateLimit(`deposit_status:${getClientIp(request)}`);
    if (!limit.success) {
      throw new ApiError(429, "Rate limit exceeded");
    }

    const env = getEnv();
    const params = new URLSearchParams();
    if (depositHash) params.set("deposit_hash", depositHash);
    if (commitHash) params.set("commit_hash", commitHash);
    if (commitment) params.set("commitment", commitment);

    const url = `${env.VELA_BACKEND_URL.replace(/\/$/, "")}/api/deposit_status?${params.toString()}`;
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "X-VELA-API-Key": env.VELA_BACKEND_API_KEY,
      },
      cache: "no-store",
    });

    const data = (await response.json().catch(() => ({
      error: `Backend returned status ${response.status}`,
    }))) as { error?: string } | { indexed: boolean };

    if (!response.ok) {
      const msg = "error" in data ? String(data.error) : `Backend error ${response.status}`;
      throw new ApiError(response.status, msg, "BACKEND_ERROR");
    }

    return data;
  });
}
