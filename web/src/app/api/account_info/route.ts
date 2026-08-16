import { NextRequest } from "next/server";
import { getAccountInfo } from "@/lib/nano-rpc";
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

    const limit = await checkRateLimit(`account_info:${getClientIp(request)}`);
    if (!limit.success) {
      throw new ApiError(429, "Rate limit exceeded");
    }

    try {
      return await getAccountInfo(parsed.data.account);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("Account not found")) {
        return {
          opened: false,
          balance: "0",
          frontier: null,
          representative: null,
        };
      }
      throw err;
    }
  });
}
