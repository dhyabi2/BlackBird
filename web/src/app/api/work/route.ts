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

async function generateWorkLocally(hash: string, threshold: string): Promise<string> {
  // nanocurrency.computeWork uses WASM and runs in the Node.js server runtime.
  const computeWork = (nano as unknown as { computeWork: (blockHash: string, params?: { workThreshold?: string }) => Promise<string | null> }).computeWork;
  const validateWork = (nano as unknown as { validateWork: (params: { blockHash: string; work: string; threshold?: string }) => boolean }).validateWork;
  const work = await computeWork(hash, { workThreshold: threshold });
  if (!work) {
    throw new Error("Failed to compute work");
  }
  const valid = validateWork({ blockHash: hash, work, threshold });
  if (!valid) {
    throw new Error("Locally computed work failed validation");
  }
  return work;
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
    const validateWork = (nano as unknown as { validateWork: (params: { blockHash: string; work: string; threshold?: string }) => boolean }).validateWork;

    // Primary: ask rpc.nano.to for work. It returns default-threshold work valid for any block type.
    try {
      const rpcResult = (await nanoRpcCall("work_generate", { hash: parsed.data.hash })) as {
        work?: string;
      };
      if (rpcResult.work) {
        // If the RPC returns invalid/cached placeholder work (e.g. zero credits),
        // fall back to local generation instead of letting the user hit "Block work is less than threshold".
        const rpcValid = validateWork({
          blockHash: parsed.data.hash,
          work: rpcResult.work,
          threshold,
        });
        if (rpcValid) {
          return { work: rpcResult.work };
        }
      }
    } catch (err) {
      // rpc.nano.to failed; continue to local fallback.
      console.warn("rpc.nano.to work_generate failed, falling back:", err);
    }

    // Fallback: compute work server-side. This keeps the UX working when the RPC key has no credits.
    const localWork = await generateWorkLocally(parsed.data.hash, threshold);
    return { work: localWork };
  });
}
