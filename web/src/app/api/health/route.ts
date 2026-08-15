import { NextRequest } from "next/server";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { withApiHandler, optionsHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function GET(request: NextRequest) {
  return withApiHandler(async () => {
    const nanoVersion = await nanoRpcCall<{ node_vendor?: string }>("version");
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      nano: {
        reachable: true,
        vendor: nanoVersion.node_vendor ?? "unknown",
      },
      ip: request.headers.get("x-forwarded-for") ?? "unknown",
    };
  });
}
