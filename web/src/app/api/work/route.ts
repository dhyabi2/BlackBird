import { NextRequest } from "next/server";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { z } from "zod";
import * as nano from "nanocurrency";

export const dynamic = "force-dynamic";

const workSchema = z.object({
  hash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Invalid 64-character hex hash"),
  difficulty: z.string().regex(/^[0-9a-fA-F]{16}$/, "Invalid 16-character hex threshold").optional(),
});

const DEFAULT_WORK_THRESHOLD = "ffffffc000000000";

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

    const threshold = parsed.data.difficulty ?? DEFAULT_WORK_THRESHOLD;

    // Always use rpc.nano.to. If it cannot produce valid work, we fail the request
    // so that clients cannot deposit into a pool they cannot withdraw from.
    const rpcResult = (await nanoRpcCall("work_generate", {
      hash: parsed.data.hash,
      difficulty: threshold,
    })) as {
      work?: string;
      difficulty?: string;
    };

    const work = rpcResult.work;
    if (!work) {
      throw new ApiError(502, "Work generator did not return work");
    }

    const validateWork = (nano as unknown as { validateWork: (params: { blockHash: string; work: string; threshold?: string }) => boolean }).validateWork;
    const rpcValid = validateWork({
      blockHash: parsed.data.hash,
      work,
      threshold,
    });

    if (!rpcValid) {
      console.warn("RPC work_generate returned invalid work", {
        hash: parsed.data.hash,
        threshold,
        returnedDifficulty: rpcResult.difficulty,
        work,
      });
      throw new ApiError(502, "Work generator returned invalid work");
    }

    return { work };
  });
}
