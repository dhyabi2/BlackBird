import { nanoRpcCall } from "@/lib/nano-rpc";
import { withApiHandler, optionsHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function GET() {
  return withApiHandler(async () => {
    await nanoRpcCall<{ node_vendor?: string }>("version");
    return {
      ok: true,
      timestamp: new Date().toISOString(),
    };
  });
}
