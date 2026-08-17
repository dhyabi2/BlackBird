import { NextRequest } from "next/server";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { z } from "zod";

// Work generation is proxied to rpc.nano.to only (no local fallback).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const workSchema = z.object({
  hash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Invalid 64-character hex hash"),
  difficulty: z.string().regex(/^[0-9a-fA-F]{16}$/, "Invalid 16-character hex threshold").optional(),
});

export function OPTIONS() {
  return optionsHandler();
}

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const body = await request.json().catch(() => null);
    if (!body) {
      throw new ApiError(400, "Invalid JSON body");
    }

    const parsed = workSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "Validation failed");
    }

    const limit = await checkRateLimit(`work:${getClientIp(request)}`);
    if (!limit.success) {
      throw new ApiError(429, "Rate limit exceeded");
    }

    const threshold = parsed.data.difficulty ?? "fffffe0000000000";

    const rpcResult = (await nanoRpcCall("work_generate", {
      hash: parsed.data.hash,
      difficulty: threshold,
    })) as { work?: string };

    if (!rpcResult.work) {
      throw new ApiError(502, "Work generation failed");
    }

    return { work: rpcResult.work };
  });
}
