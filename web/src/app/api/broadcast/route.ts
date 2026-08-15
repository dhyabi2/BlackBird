import { NextRequest } from "next/server";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { z } from "zod";

export const dynamic = "force-dynamic";

const broadcastSchema = z.object({
  block: z.record(z.string(), z.any()),
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

    const parsed = broadcastSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "Validation failed");
    }

    const limit = await checkRateLimit(`broadcast:${getClientIp(request)}`);
    if (!limit.success) {
      throw new ApiError(429, "Rate limit exceeded");
    }

    return nanoRpcCall("process", {
      json_block: "true",
      block: parsed.data.block,
    });
  });
}
