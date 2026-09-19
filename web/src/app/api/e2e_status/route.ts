import { getE2eStatus } from "@/lib/vela-backend";
import { withApiHandler, optionsHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function GET() {
  return withApiHandler(async () => {
    try {
      return await getE2eStatus();
    } catch (err) {
      // The probe's own reachability is part of what it reports. If the backend
      // is down we cannot claim the pipeline is healthy, so surface "unknown"
      // rather than letting the route 500 and the banner silently disappear.
      return {
        ok: null,
        state: "unknown" as const,
        error: err instanceof Error ? err.message : "Backend unreachable",
      };
    }
  });
}
