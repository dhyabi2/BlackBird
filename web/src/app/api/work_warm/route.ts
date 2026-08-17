import { NextRequest } from "next/server";
import { warmServerWork } from "@/lib/server-work";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { z } from "zod";

export const dynamic = "force-dynamic";

const warmSchema = z.object({
  hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  difficulty: z.string().regex(/^[0-9a-fA-F]{16}$/).optional(),
});

export function OPTIONS() {
  return optionsHandler();
}

// Queue server-side precomputation of proof-of-work for a future root.
// Fire-and-forget from the client's perspective: block hashes exclude the
// work value, so upcoming roots are known long before their work is needed.
export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const body = await request.json().catch(() => null);
    if (!body) throw new ApiError(400, "Invalid JSON body");
    const parsed = warmSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "Validation failed");

    const limit = await checkRateLimit(`work_warm:${getClientIp(request)}`);
    if (!limit.success) throw new ApiError(429, "Rate limit exceeded");

    await warmServerWork(parsed.data.hash, parsed.data.difficulty ?? "fffffff800000000");
    return { ok: true };
  });
}
