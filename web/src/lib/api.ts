import { getEnv } from "./env";

export const corsHeaders = () => ({
  "Access-Control-Allow-Origin": getEnv().NEXT_PUBLIC_APP_URL,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
});

export function optionsHandler() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function withApiHandler<T>(
  handler: () => Promise<T>
): Promise<Response> {
  try {
    const data = await handler();
    return Response.json(data, { headers: corsHeaders() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = err && typeof err === "object" && "status" in err ? Number(err.status) : 500;
    console.error("API error:", err);
    return Response.json(
      { error: message },
      { status: status || 500, headers: corsHeaders() }
    );
  }
}
