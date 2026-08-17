import { NextRequest } from "next/server";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { z } from "zod";

export const dynamic = "force-dynamic";

const hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/);
const hex128 = z.string().regex(/^[0-9a-fA-F]{128}$/);
const hex16 = z.string().regex(/^[0-9a-fA-F]{16}$/);

const broadcastSchema = z.object({
  block: z.object({
    type: z.literal("state"),
    account: z.string().regex(/^nano_[13456789abcdefghijkmnopqrstuwxyz]{60}$/),
    previous: hex64,
    representative: z.string().regex(/^nano_[13456789abcdefghijkmnopqrstuwxyz]{60}$/),
    balance: z.string().regex(/^\d+$/),
    link: hex64,
    signature: hex128,
    work: hex16,
  }),
  subtype: z.enum(["send", "receive", "change", "open"]).optional(),
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
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new ApiError(400, `Broadcast block validation failed: ${issues}`);
    }

    const limit = await checkRateLimit(`broadcast:${getClientIp(request)}`);
    if (!limit.success) {
      throw new ApiError(429, "Rate limit exceeded");
    }

    return nanoRpcCall("process", {
      json_block: "true",
      subtype: parsed.data.subtype,
      block: parsed.data.block,
    });
  });
}
