import { NextRequest } from "next/server";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";
import { validateWork } from "@/lib/work";
import { getServerWork } from "@/lib/server-work";
import { getPublicWork } from "@/lib/public-work";
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

    // 1. Primary: the paid rpc.nano.to GPU work service (~0.1-0.6s; their
    //    invalid-nonce bug was fixed 2026-08-19). Every nonce is still
    //    validated locally before use — never trusted blindly.
    const primary = await nanoRpcCall("work_generate", {
      hash: parsed.data.hash,
      difficulty: threshold,
    })
      .then((r) => {
        const work = (r as { work?: string }).work;
        return work && validateWork(work, parsed.data.hash, threshold)
          ? { work, source: "rpc.nano.to" }
          : null;
      })
      .catch(() => null);
    if (primary) return primary;

    // 2. Fallback (RPC down or invalid nonce): the backend work service
    //    (pre-warmed cache / CPU compute) and the flaky public endpoints in
    //    parallel — first locally-valid result wins.
    const serverAttempt = getServerWork(parsed.data.hash, threshold).then(
      (work) =>
        work && validateWork(work, parsed.data.hash, threshold)
          ? { work, source: "server" }
          : null
    );

    const publicAttempt = getPublicWork(parsed.data.hash, threshold);

    const remote = await new Promise<{ work: string; source: string } | null>((resolve) => {
      let unresolved = 2;
      const settle = (r: { work: string; source: string } | null) => {
        if (r) resolve(r);
        else if (--unresolved === 0) resolve(null);
      };
      serverAttempt.then(settle, () => settle(null));
      publicAttempt.then(settle, () => settle(null));
    });

    if (remote) return remote;

    throw new ApiError(
      502,
      "No valid proof-of-work available yet; it is being computed in the background."
    );
  });
}

export const OPTIONS = optionsHandler;
