import { NextRequest } from "next/server";
import { generateWork, validateWork, type WorkType } from "nano-rspow-node";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { z } from "zod";

// Work generation can be CPU-intensive. Allow up to 60s for the serverless function.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SEND_THRESHOLD = "fffffff800000000";
const RECEIVE_THRESHOLD = "fffffe0000000000";

const workSchema = z.object({
  hash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Invalid 64-character hex hash"),
  difficulty: z.string().regex(/^[0-9a-fA-F]{16}$/, "Invalid 16-character hex threshold").optional(),
});

function workTypeForDifficulty(difficulty: string): WorkType {
  // Send/change threshold is the higher difficulty. Anything else is treated as receive/open.
  return (difficulty.toLowerCase() === SEND_THRESHOLD ? "Send" : "Receive") as WorkType;
}

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

    const threshold = parsed.data.difficulty ?? RECEIVE_THRESHOLD;
    const type = workTypeForDifficulty(threshold);
    const hash = parsed.data.hash;

    // BPMN: the Web App proxies work generation to rpc.nano.to. If rpc.nano.to returns
    // unusable work (e.g., a free/cached value below the requested threshold), fall back
    // to local CPU generation so the client always receives valid work. No extra RPC
    // endpoints are introduced.
    try {
      const rpcResult = (await nanoRpcCall("work_generate", {
        hash,
        difficulty: threshold,
      })) as { work?: string };

      if (rpcResult.work && validateWork(hash, rpcResult.work, type)) {
        return { work: rpcResult.work };
      }
    } catch {
      // rpc.nano.to failed or returned invalid work; generate locally.
    }

    const work = await generateWork(hash, type);
    return { work };
  });
}
