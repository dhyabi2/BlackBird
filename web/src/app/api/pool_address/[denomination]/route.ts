import { getPoolAddress } from "@/lib/vela-backend";
import { withApiHandler, optionsHandler } from "@/lib/api";
import { ALLOWED_DENOMINATIONS } from "@/lib/denominations";
import { ApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ denomination: string }> }
) {
  return withApiHandler(async () => {
    const { denomination } = await params;
    if (!ALLOWED_DENOMINATIONS.includes(denomination)) {
      throw new ApiError(400, "Invalid denomination");
    }
    return getPoolAddress(denomination);
  });
}
