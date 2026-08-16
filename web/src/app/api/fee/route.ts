import { getFeeConfig } from "@/lib/vela-backend";
import { withApiHandler, optionsHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function GET() {
  return withApiHandler(async () => {
    const config = await getFeeConfig();
    return {
      fee_bps: config.fee_bps ?? 0,
      fee_percent: config.fee_percent ?? 0,
    };
  });
}
