import { NextRequest } from "next/server";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { validateWork } from "@/lib/work";
import { getServerWork } from "@/lib/server-work";
import { z } from "zod";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const workSchema = z.object({
  hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  difficulty: z.string().regex(/^[0-9a-fA-F]{16}$/).optional(),
});

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const body = await request.json().catch(() => null);
    if (!body) throw new ApiError(400, "Invalid JSON body");
    const parsed = workSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "Validation failed");

    const limit = await checkRateLimit(`work:${getClientIp(request)}`);
    if (!limit.success) throw new ApiError(429, "Rate limit exceeded");

    const threshold = parsed.data.difficulty ?? "fffffe0000000000";

    // 1. Backend work service: pre-warmed cache (pool frontiers, post-broadcast
    //    roots) or on-demand CPU compute for receive difficulty.
    const serverWork = await getServerWork(parsed.data.hash, threshold);
    if (serverWork && validateWork(serverWork, parsed.data.hash, threshold)) {
      return { work: serverWork, source: "server" };
    }

    // 2. rpc.nano.to, validated locally (its work service has a history of
    //    returning invalid nonces).
    const rpcResult = (await nanoRpcCall("work_generate", {
      hash: parsed.data.hash,
      difficulty: threshold,
    }).catch(() => ({}))) as { work?: string };

    if (rpcResult.work && validateWork(rpcResult.work, parsed.data.hash, threshold)) {
      return { work: rpcResult.work, source: "rpc" };
    }

    throw new ApiError(
      502,
      "No valid proof-of-work available yet; it is being computed in the background."
    );
  });
}

export const OPTIONS = optionsHandler;
