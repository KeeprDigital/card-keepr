export type RuntimeHealth = {
  contract: "card-keepr-runtime-health@1";
  runtime: "api" | "ingestion";
  status: "ok";
  capabilities: readonly string[];
};

export function healthResponse(health: RuntimeHealth): Response {
  return Response.json(health, {
    headers: {
      "cache-control": "no-store",
    },
  });
}

export function assertBindingsAvailable(
  boundary: "read" | "mutation",
  ...bindings: readonly (D1Database | R2Bucket)[]
): void {
  if (bindings.some((binding) => binding === null || binding === undefined)) {
    throw new Error(`Required ${boundary} bindings are unavailable`);
  }
}
