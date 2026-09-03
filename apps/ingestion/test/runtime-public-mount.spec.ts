import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import ingestionWorker from "../src/index";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

// Issue #123: production mounts the ingestion worker at
// https://card.keepr.digital/ingest. The mount is derived from
// PUBLIC_BASE_URL alone, so this suite overrides the var per request while
// every other spec keeps the root-mounted base.
const publicBase = "https://card.keepr.digital/ingest";
const mountedEnv = { ...env, PUBLIC_BASE_URL: publicBase } as Env;

function mountedRequest(
  path: string,
  init: { method?: string; body?: unknown; authenticated?: boolean } = {},
): Promise<Response> {
  const { method = "GET", body, authenticated = true } = init;
  return ingestionWorker.fetch(
    new Request(`https://card.keepr.digital${path}`, {
      method,
      headers: {
        ...(authenticated
          ? { authorization: "Bearer vitest-administration-key" }
          : {}),
        "cf-connecting-ip": "198.51.100.31",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    mountedEnv,
  );
}

test("the health route answers under the mount and nowhere else", async () => {
  const mounted = await mountedRequest("/ingest/health");
  expect(mounted.status).toBe(200);
  await expect(mounted.json()).resolves.toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "ingestion",
    status: "ok",
  });

  const root = await mountedRequest("/health", { authenticated: false });
  expect(root.status).toBe(404);
  expect(root.headers.get("content-type")).toBe("application/problem+json");
  await expect(root.json()).resolves.toMatchObject({ code: "not_found" });

  const unauthenticated = await mountedRequest("/ingest/health", {
    authenticated: false,
  });
  expect(unauthenticated.status).toBe(401);
});

test("administration operation links are absolute public URLs", async () => {
  // An orphaned retry claim makes the route report the operation as in
  // progress; that document is the ingestion worker's link-bearing response.
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO administration_idempotency_claims (
       idempotency_key, operation, request_json, claimed_at,
       owner_token, claim_version, claim_expires_at
     ) VALUES (?, 'retry_ingestion_run', ?, ?, ?, 1, ?)`,
  )
    .bind(
      "retry-public-mount",
      `{"source_run_id":"run_public_mount"}`,
      "2026-07-29T04:00:00.000Z",
      "administration-claim:public-mount",
      "2099-01-01T00:00:00.000Z",
    )
    .run();

  const response = await mountedRequest(
    "/ingest/v1/ingestion-runs/run_public_mount/retry",
    { method: "POST", body: { idempotency_key: "retry-public-mount" } },
  );
  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toMatchObject({
    contract: "card-keepr-administration-operation@1",
    operation: "retry_ingestion_run",
    status: "in_progress",
    links: { status: `${publicBase}/v1/status` },
  });
});
