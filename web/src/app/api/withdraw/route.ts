import { NextRequest } from "next/server";
import { submitWithdrawal } from "@/lib/vela-backend";
import { withdrawRequestSchema } from "@/lib/validate";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const body = await request.json().catch(() => null);
    if (!body) {
      throw new ApiError(400, "Invalid JSON body");
    }

    const parsed = withdrawRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "Validation failed");
    }

    const limit = await checkRateLimit(`withdraw:${getClientIp(request)}`);
    if (!limit.success) {
      throw new ApiError(429, "Rate limit exceeded");
    }

    return submitWithdrawal(parsed.data);
  });
}
