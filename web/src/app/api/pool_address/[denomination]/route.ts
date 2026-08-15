import { getPoolAddress } from "@/lib/vela-backend";
import { withApiHandler, optionsHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ denomination: string }> }
) {
  return withApiHandler(async () => {
    const { denomination } = await params;
    return getPoolAddress(denomination);
  });
}
