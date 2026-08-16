import { NextRequest } from "next/server";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { z } from "zod";

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

    // Use only rpc.nano.to for work generation. We trust the work it returns,
    // matching the XNO_TEMPLATE pattern, because the network will reject an
    // invalid work value during process anyway.
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

    return { work };
  });
}
