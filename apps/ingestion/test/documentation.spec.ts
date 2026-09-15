import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import ingestionWorker from "../src/index";
import contract from "../../../contracts/admin-openapi.json";
import { assertHttpResponse } from "../../../test/support/http-contract";
import { assertDocumentationPage } from "../../../test/support/documentation";

test("the owner can read complete administration documentation while catalogue storage is unavailable", async () => {
  const unavailable = {
    ...env,
    ADMINISTRATION_KEY_REPLACEMENT: "replacement-owner",
    PUBLIC_BASE_URL: "https://card-staging.keepr.digital/ingest/",
    CATALOGUE_DB: new Proxy(env.CATALOGUE_DB, {
      get(target, property, receiver) {
        if (property === "prepare")
          return () => {
            throw new Error("Catalogue storage unavailable");
          };
        return Reflect.get(target, property, receiver);
      },
    }),
  };
  const request = (path: string, key?: string) =>
    ingestionWorker.fetch(
      new Request(`https://alternate.invalid/ingest${path}`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      }),
      unavailable,
    );
  for (const path of ["/docs", "/openapi.json"]) {
    expect((await request(path)).status).toBe(401);
    expect((await request(path, "vitest-api-key")).status).toBe(401);
  }
  const page = await request("/docs", "vitest-administration-key");
  expect(page.status).toBe(200);
  await assertHttpResponse(contract, "/docs", "get", page);
  expect(page.headers.get("cache-control")).toBe("private, no-store");
  const html = await page.text();
  assertDocumentationPage(html, contract, "https://card-staging.keepr.digital/ingest/openapi.json");
  expect(html).toContain("/v1/production-releases");
  expect(html).toContain("https://card-staging.keepr.digital/ingest/openapi.json");
  expect(html).not.toContain("vitest-administration-key");
  const response = await request("/openapi.json", "vitest-administration-key");
  expect(response.status).toBe(200);
  await assertHttpResponse(contract, "/openapi.json", "get", response);
  const spec = await response.json<{ servers: { url: string }[]; paths: Record<string, unknown> }>();
  expect(spec.servers).toEqual([{ url: "https://card-staging.keepr.digital/ingest" }]);
  expect(spec.paths).toHaveProperty("/v1/production-releases");
  expect(spec.paths).toHaveProperty("/docs");
  expect(spec.paths).toHaveProperty("/openapi.json");
  expect((await request("/docs", "replacement-owner")).status).toBe(200);
  expect((await request("/openapi.json", "replacement-owner")).status).toBe(200);
});

test("administration documentation remains inside the mount and administration rate limit", async () => {
  let attempts = 0;
  const environment = {
    ...env,
    PUBLIC_BASE_URL: "https://card.keepr.digital/ingest",
    ADMINISTRATION_RATE_LIMIT: {
      limit: async () => {
        attempts += 1;
        return { success: false };
      },
    },
  };
  const outside = await ingestionWorker.fetch(new Request("https://alternate.invalid/docs"), environment);
  expect(outside.status).toBe(404);
  expect(attempts).toBe(0);
  const limited = await ingestionWorker.fetch(
    new Request("https://alternate.invalid/ingest/docs", {
      headers: { authorization: "Bearer vitest-administration-key" },
    }),
    environment,
  );
  expect(limited.status).toBe(429);
  await assertHttpResponse(contract, "/docs", "get", limited);
  expect(attempts).toBe(1);
});
