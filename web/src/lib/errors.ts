import { z } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonResponse(data: unknown, status = 200, init?: ResponseInit) {
  return Response.json(data, { status, ...init });
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status }
    );
  }

  if (error instanceof z.ZodError) {
    const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return Response.json({ error: "Validation failed", issues }, { status: 400 });
  }

  const message = error instanceof Error ? error.message : "Internal server error";
  console.error("API error:", error);
  return Response.json({ error: message }, { status: 500 });
}
