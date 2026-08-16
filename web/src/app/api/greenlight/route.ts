import { getEnv } from "@/lib/env";
import { nanoRpcCall } from "@/lib/nano-rpc";
import { withApiHandler, optionsHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsHandler();
}

export async function GET() {
  return withApiHandler(async () => {
    const env = getEnv();

    // Check Nano RPC is live and returning recent data.
    const nanoHealth = await nanoRpcCall<{ node_vendor?: string; block_count?: string }>(
      "block_count"
    );
    if (!nanoHealth.block_count || BigInt(nanoHealth.block_count) < 1) {
      throw new Error("Nano RPC is not returning a valid block count");
    }

    // Check VELA backend indexer is live and has a current epoch.
    const backendUrl = `${env.VELA_BACKEND_URL.replace(/\/$/, "")}/api/status`;
    const backendRes = await fetch(backendUrl, {
      headers: {
        "Content-Type": "application/json",
        "X-VELA-API-Key": env.VELA_BACKEND_API_KEY,
      },
      cache: "no-store",
    });
    if (!backendRes.ok) {
      throw new Error("VELA backend is not responding");
    }
    const backend = (await backendRes.json()) as {
      status?: string;
      epoch?: number;
      pool_pubkey?: string;
    };
    if (backend.status !== "ok" || !backend.epoch || !backend.pool_pubkey) {
      throw new Error("VELA backend returned an invalid status");
    }

    return {
      ok: true,
      nano: {
        reachable: true,
        block_count: nanoHealth.block_count,
      },
      backend: {
        reachable: true,
        epoch: backend.epoch,
      },
    };
  });
}
