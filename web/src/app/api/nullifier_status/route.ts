import { NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

// Report whether a withdrawal nullifier has already been spent. Clients call
// this BEFORE depositing: a deposit whose (source, withdraw key) pair maps to
// a spent nullifier can never be withdrawn again.
export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const nullifier = request.nextUrl.searchParams.get("nullifier") ?? "";
    if (!/^(0x)?[0-9a-fA-F]{1,64}$/.test(nullifier)) {
      throw new ApiError(400, "Invalid nullifier");
    }
    const env = getEnv();
    const url = `${env.VELA_BACKEND_URL.replace(/\/$/, "")}/api/nullifier/${nullifier.replace(/^0x/, "")}`;
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "X-VELA-API-Key": env.VELA_BACKEND_API_KEY,
      },
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as
      | { nullifier?: string; spent?: boolean; error?: string }
      | null;
    if (!res.ok || !data || typeof data.spent !== "boolean") {
      throw new ApiError(502, data?.error || "Backend nullifier check failed");
    }
    return { nullifier: data.nullifier, spent: data.spent };
  });
}
