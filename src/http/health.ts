export type RuntimeHealth = {
  contract: "card-keepr-runtime-health@1";
  runtime: "api" | "ingestion";
  status: "ok";
  capabilities: string[];
};

export function healthResponse(health: RuntimeHealth): Response {
  return Response.json(health, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
