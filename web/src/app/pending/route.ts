import { NextRequest } from "next/server";
import { getPendingBlocks } from "@/lib/nano-rpc";
import { balanceQuerySchema } from "@/lib/validate";
import { ApiError } from "@/lib/errors";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/ip";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const account = request.nextUrl.searchParams.get("account");
    const parsed = balanceQuerySchema.safeParse({ account });
    if (!parsed.success) {
      throw new ApiError(400, "Invalid Nano address");
    }

    const limit = await checkRateLimit(`pending:${getClientIp(request)}`);
    if (!limit.success) {
      throw new ApiError(429, "Rate limit exceeded");
    }

    return getPendingBlocks(parsed.data.account);
  });
}
