import { env } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import ingestionWorker from "../src/index";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

// Issue #144: an unauthenticated liveness probe for external monitors and an
// authenticated readiness document that proves every ingestion binding.

const origin = "https://card-keepr.invalid";
const secret = "binding-failure-detail-must-not-leak";

function anonymous(path: string, init?: RequestInit): Promise<Response> {
  return ingestionWorker.fetch(
    new Request(`${origin}${path}`, {
      headers: { "cf-connecting-ip": "192.0.2.150" },
      ...init,
    }),
    env,
  );
}

function authenticated(path: string, overrides: Env = env): Promise<Response> {
  return ingestionWorker.fetch(
    new Request(`${origin}${path}`, {
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": "192.0.2.151",
      },
    }),
    overrides,
  );
}

function withOverrides(overrides: Record<string, unknown>): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in overrides) {
        return overrides[property];
      }
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

test("liveness answers without an administration key and reports only status and runtime", async () => {
  const response = await anonymous("/healthz");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({
    status: "ok",
    runtime: "ingestion",
  });
});

test("liveness leaves every administration route authenticated and unknown paths unrouted", async () => {
  const readiness = await anonymous("/health");
  expect(readiness.status).toBe(401);
  await expect(readiness.json()).resolves.toMatchObject({
    code: "authentication_required",
  });
  const status = await anonymous("/v1/status");
  expect(status.status).toBe(401);
  const posted = await anonymous("/healthz", { method: "POST" });
  expect(posted.status).toBe(401);

  const unknown = await authenticated("/healthzz");
  expect(unknown.status).toBe(404);
  await expect(unknown.json()).resolves.toMatchObject({ code: "not_found" });
});

test("liveness answers under the public mount, on its own rate limit, off the request log", async () => {
  const records: string[] = [];
  vi.spyOn(console, "info").mockImplementation((value) => {
    records.push(String(value));
  });
  const mountedEnv = withOverrides({
    PUBLIC_BASE_URL: "https://card.keepr.digital/ingest",
  });
  const mounted = await ingestionWorker.fetch(
    new Request("https://card.keepr.digital/ingest/healthz"),
    mountedEnv,
  );
  expect(mounted.status).toBe(200);
  await expect(mounted.json()).resolves.toEqual({
    status: "ok",
    runtime: "ingestion",
  });
  expect(records.filter((record) => record.includes("request.completed")))
    .toHaveLength(0);

  // Outside the mount the request is not liveness at all: it is the
  // ordinary unrouted 404, which the request log does record.
  const outside = await ingestionWorker.fetch(
    new Request("https://card.keepr.digital/healthz"),
    mountedEnv,
  );
  expect(outside.status).toBe(404);
  expect(records.filter((record) => record.includes("request.completed")))
    .toHaveLength(1);

  const limited = await ingestionWorker.fetch(
    new Request(`${origin}/healthz`),
    withOverrides({
      ADMINISTRATION_RATE_LIMIT: {
        limit: async () => {
          throw new Error("the administration limit must not govern liveness");
        },
      } as unknown as RateLimit,
      INGESTION_LIVENESS_RATE_LIMIT: {
        limit: async () => ({ success: false }),
      } as unknown as RateLimit,
    }),
  );
  expect(limited.status).toBe(429);
});

test("readiness proves the database, every bucket, every Workflow binding, the public base, and the version", async () => {
  const response = await authenticated("/health");
  expect(response.status).toBe(200);
  const document = await response.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "ingestion",
    status: "ok",
    checks: {
      database: {
        status: "pass",
        migration_level: expect.any(Number),
        current_revision_id: "catrev_spine_000",
        configured_database_id: "00000000-0000-0000-0000-000000000001",
      },
      objects: {
        status: "pass",
        buckets: {
          EVIDENCE_OBJECTS: { status: "pass" },
          PRINTING_IMAGES: { status: "pass" },
          CATALOGUE_EXPORTS: { status: "pass" },
          BACKUPS: { status: "pass" },
        },
      },
      workflows: {
        status: "pass",
        bindings: {
          EVIDENCE_INGESTION_WORKFLOW: { status: "pass" },
          EVIDENCE_HOST_WORKFLOW: { status: "pass" },
          RECONCILIATION_WORKFLOW: { status: "pass" },
          CATALOGUE_BACKUP_WORKFLOW: { status: "pass" },
        },
      },
      public_base: {
        status: "pass",
        configured: "http://127.0.0.1:8788",
        arrived_through_public_base: false,
      },
      version: { status: "pass" },
    },
  });
  expect(Object.keys(document.checks as object).sort()).toEqual([
    "database",
    "objects",
    "public_base",
    "version",
    "workflows",
  ]);
});

test("a broken Workflow binding turns readiness degraded for that binding only", async () => {
  const response = await authenticated(
    "/health",
    withOverrides({
      RECONCILIATION_WORKFLOW: {
        get: async () => {
          throw new Error(`workflow binding failure ${secret}`);
        },
      },
    }),
  );
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({
    status: "degraded",
    checks: {
      database: { status: "pass" },
      workflows: {
        status: "fail",
        bindings: {
          EVIDENCE_INGESTION_WORKFLOW: { status: "pass" },
          RECONCILIATION_WORKFLOW: { status: "fail", reason: "probe_failed" },
          CATALOGUE_BACKUP_WORKFLOW: { status: "pass" },
        },
      },
    },
  });
  expect(text).not.toContain(secret);

  const missing = await authenticated(
    "/health",
    withOverrides({ EVIDENCE_HOST_WORKFLOW: undefined }),
  );
  expect(missing.status).toBe(503);
  await expect(missing.json()).resolves.toMatchObject({
    checks: {
      workflows: {
        bindings: {
          EVIDENCE_HOST_WORKFLOW: { status: "fail", reason: "binding_missing" },
        },
      },
    },
  });
});

test("a broken database or bucket binding turns readiness degraded", async () => {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((value) => {
    errors.push(String(value));
  });
  const brokenDatabase = new Proxy(env.CATALOGUE_DB, {
    get(database, property, receiver) {
      if (property === "prepare") {
        return () => {
          throw new Error(secret);
        };
      }
      return Reflect.get(database, property, receiver);
    },
  });
  const database = await authenticated(
    "/health",
    withOverrides({ CATALOGUE_DB: brokenDatabase }),
  );
  expect(database.status).toBe(503);
  const databaseText = await database.text();
  expect(JSON.parse(databaseText)).toMatchObject({
    status: "degraded",
    checks: {
      database: { status: "fail", reason: "query_failed" },
      workflows: { status: "pass" },
    },
  });
  expect(databaseText).not.toContain(secret);
  expect(errors.join("\n")).not.toContain(secret);

  const bucket = await authenticated(
    "/health",
    withOverrides({
      BACKUPS: {
        list: async () => {
          throw new Error(secret);
        },
      },
    }),
  );
  expect(bucket.status).toBe(503);
  await expect(bucket.json()).resolves.toMatchObject({
    status: "degraded",
    checks: {
      objects: {
        status: "fail",
        buckets: {
          EVIDENCE_OBJECTS: { status: "pass" },
          BACKUPS: { status: "fail", reason: "probe_failed" },
        },
      },
    },
  });
});

test("readiness fails when the configured catalogue database id is absent", async () => {
  const response = await authenticated(
    "/health",
    withOverrides({ CATALOGUE_D1_DATABASE_ID: "" }),
  );
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toMatchObject({
    status: "degraded",
    checks: {
      database: { status: "fail", reason: "database_id_not_configured" },
    },
  });
});
