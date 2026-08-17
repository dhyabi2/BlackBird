import { NextRequest } from "next/server";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { z } from "zod";

export const dynamic = "force-dynamic";

const blocksInfoSchema = z.object({
  hashes: z.array(z.string().regex(/^[0-9a-fA-F]{64}$/)).min(1).max(20),
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

    const parsed = blocksInfoSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new ApiError(400, `Validation failed: ${issues}`);
    }

    const limit = await checkRateLimit(`blocks_info:${getClientIp(request)}`);
    if (!limit.success) {
      throw new ApiError(429, "Rate limit exceeded");
    }

    const data = (await nanoRpcCall("blocks_info", {
      hashes: parsed.data.hashes,
      json_block: "true",
    })) as { blocks?: Record<string, { confirmed?: string; contents?: Record<string, unknown> }> };

    return data.blocks ?? {};
  });
}
