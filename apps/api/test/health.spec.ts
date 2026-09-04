import { expect, test, vi } from "vitest";
import apiWorker from "../src/index";
import { apiHeaders, installApiSuite, testEnv } from "./api-fixtures";

installApiSuite();

// Issue #144: an unauthenticated liveness probe for external monitors and an
// authenticated readiness document that proves the bindings.

const origin = "https://card-keepr.invalid";

function anonymous(path: string, init?: RequestInit): Promise<Response> {
  return apiWorker.fetch(
    new Request(`${origin}${path}`, {
      headers: { "cf-connecting-ip": "192.0.2.144" },
      ...init,
    }),
    testEnv,
  );
}

function authenticated(path: string, env: Env = testEnv): Promise<Response> {
  return apiWorker.fetch(
    new Request(`${origin}${path}`, { headers: apiHeaders("192.0.2.145") }),
    env,
  );
}

function withOverrides(overrides: Record<string, unknown>): Env {
  return new Proxy(testEnv, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in overrides) {
        return overrides[property];
      }
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

const secret = "binding-failure-detail-must-not-leak";

function brokenDatabase(): D1Database {
  return new Proxy(testEnv.CATALOGUE_DB, {
    get(database, property, receiver) {
      if (property === "prepare") {
        return () => {
          throw new Error(secret);
        };
      }
      return Reflect.get(database, property, receiver);
    },
  });
}

function brokenBucket(): R2Bucket {
  return {
    list: async () => {
      throw new Error(secret);
    },
  } as unknown as R2Bucket;
}

test("liveness answers without a bearer key and reports only status and runtime", async () => {
  const response = await anonymous("/healthz");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({
    status: "ok",
    runtime: "api",
  });

  const head = await anonymous("/healthz", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});

test("liveness leaves every sibling route authenticated and unknown paths unrouted", async () => {
  const readiness = await anonymous("/health");
  expect(readiness.status).toBe(401);
  await expect(readiness.json()).resolves.toMatchObject({
    code: "authentication_required",
  });

  const catalogue = await anonymous("/v1/catalogue");
  expect(catalogue.status).toBe(401);

  const nested = await anonymous("/healthz/extra");
  expect(nested.status).toBe(401);

  const posted = await anonymous("/healthz", { method: "POST" });
  expect(posted.status).toBe(401);

  const unknown = await authenticated("/healthzz");
  expect(unknown.status).toBe(404);
  await expect(unknown.json()).resolves.toMatchObject({ code: "not_found" });
});

test("liveness answers under the public mount and nowhere else", async () => {
  const mountedEnv = withOverrides({
    PUBLIC_BASE_URL: "https://card.keepr.digital/api",
  });
  const mounted = await apiWorker.fetch(
    new Request("https://card.keepr.digital/api/healthz"),
    mountedEnv,
  );
  expect(mounted.status).toBe(200);
  await expect(mounted.json()).resolves.toEqual({
    status: "ok",
    runtime: "api",
  });

  const outside = await apiWorker.fetch(
    new Request("https://card.keepr.digital/healthz"),
    mountedEnv,
  );
  expect(outside.status).toBe(404);
});

test("liveness has its own rate limit and stays out of the operational request log", async () => {
  const records: string[] = [];
  vi.spyOn(console, "info").mockImplementation((value) => {
    records.push(String(value));
  });

  const live = await anonymous("/healthz");
  expect(live.status).toBe(200);
  expect(records.filter((record) => record.includes("request.completed")))
    .toHaveLength(0);

  const catalogueLimit = {
    limit: async () => {
      throw new Error("the catalogue limit must not govern liveness");
    },
  } as unknown as RateLimit;
  const limited = await apiWorker.fetch(
    new Request(`${origin}/healthz`),
    withOverrides({
      CATALOGUE_RATE_LIMIT: catalogueLimit,
      PRINTING_IMAGE_RATE_LIMIT: catalogueLimit,
      API_LIVENESS_RATE_LIMIT: {
        limit: async () => ({ success: false }),
      } as unknown as RateLimit,
    }),
  );
  expect(limited.status).toBe(429);
  await expect(limited.json()).resolves.toMatchObject({
    code: "rate_limited",
  });
});

test("readiness proves the database, both buckets, the public base, and the version", async () => {
  const response = await authenticated("/health");
  expect(response.status).toBe(200);
  const document = await response.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "api",
    status: "ok",
    checks: {
      database: {
        status: "pass",
        migration_level: expect.any(Number),
        current_revision_id: "catrev_spine_000",
      },
      objects: {
        status: "pass",
        buckets: {
          PRINTING_IMAGES: { status: "pass" },
          CATALOGUE_EXPORTS: { status: "pass" },
        },
      },
      public_base: {
        status: "pass",
        configured: "http://127.0.0.1:8787",
        arrived_through_public_base: false,
      },
      version: { status: "pass" },
    },
  });
  const checks = document.checks as Record<string, unknown>;
  expect(Object.keys(checks).sort()).toEqual([
    "database",
    "objects",
    "public_base",
    "version",
  ]);
});

test("readiness reports the public base as reached when the request arrives through it", async () => {
  const response = await apiWorker.fetch(
    new Request("https://card.keepr.digital/api/health", {
      headers: apiHeaders("192.0.2.146"),
    }),
    withOverrides({ PUBLIC_BASE_URL: "https://card.keepr.digital/api" }),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    checks: {
      public_base: {
        configured: "https://card.keepr.digital/api",
        arrived_through_public_base: true,
      },
    },
  });
});

test("a broken database binding turns readiness degraded without leaking the failure", async () => {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((value) => {
    errors.push(String(value));
  });
  const response = await authenticated(
    "/health",
    withOverrides({ CATALOGUE_DB: brokenDatabase() }),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  const document = JSON.parse(text) as Record<string, unknown>;
  expect(document).toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "api",
    status: "degraded",
    checks: {
      database: { status: "fail", reason: "query_failed" },
      objects: { status: "pass" },
    },
  });
  expect(text).not.toContain(secret);
  expect(errors.join("\n")).not.toContain(secret);
});

test("a broken or missing bucket binding fails only that bucket", async () => {
  const broken = await authenticated(
    "/health",
    withOverrides({ CATALOGUE_EXPORTS: brokenBucket() }),
  );
  expect(broken.status).toBe(503);
  const brokenText = await broken.text();
  expect(JSON.parse(brokenText)).toMatchObject({
    status: "degraded",
    checks: {
      database: { status: "pass" },
      objects: {
        status: "fail",
        buckets: {
          PRINTING_IMAGES: { status: "pass" },
          CATALOGUE_EXPORTS: { status: "fail", reason: "probe_failed" },
        },
      },
    },
  });
  expect(brokenText).not.toContain(secret);

  const missing = await authenticated(
    "/health",
    withOverrides({ PRINTING_IMAGES: undefined }),
  );
  expect(missing.status).toBe(503);
  await expect(missing.json()).resolves.toMatchObject({
    status: "degraded",
    checks: {
      objects: {
        buckets: {
          PRINTING_IMAGES: { status: "fail", reason: "binding_missing" },
          CATALOGUE_EXPORTS: { status: "pass" },
        },
      },
    },
  });
});

test("readiness fails a database whose schema state is unreadable", async () => {
  const noSchema = new Proxy(testEnv.CATALOGUE_DB, {
    get(database, property, receiver) {
      if (property === "prepare") {
        return (query: string) =>
          database.prepare(
            query.replace("catalogue_schema_state", "missing_schema_state"),
          );
      }
      return Reflect.get(database, property, receiver);
    },
  });
  const response = await authenticated(
    "/health",
    withOverrides({ CATALOGUE_DB: noSchema }),
  );
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toMatchObject({
    status: "degraded",
    checks: { database: { status: "fail", reason: "query_failed" } },
  });
});
