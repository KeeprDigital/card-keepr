import { expect, test } from "vitest";
import apiWorker from "../src/index";
import { testEnv } from "./api-fixtures";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/read-openapi.json";
import { assertDocumentationPage } from "../../../test/support/documentation";

test("anonymous readers can open complete catalogue documentation at the configured public mount", async () => {
  const env = { ...testEnv, PUBLIC_BASE_URL: "https://card-dev.keepr.digital/api/" };
  const page = await apiWorker.fetch(new Request("https://alternate.invalid/api/docs"), env);
  expect(page.status).toBe(200);
  await assertHttpResponse(contract, "/docs", "get", page);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const html = await page.text();
  assertDocumentationPage(html, contract, "https://card-dev.keepr.digital/api/openapi.json");
  expect(html).toContain("/v1/games");
  expect(html).toContain("https://card-dev.keepr.digital/api/openapi.json");
  expect(html).not.toContain("/v1/production-releases");
  expect(html).not.toContain("vitest-api-key");
  const response = await apiWorker.fetch(new Request("https://alternate.invalid/api/openapi.json"), env);
  expect(response.status).toBe(200);
  await assertHttpResponse(contract, "/openapi.json", "get", response);
  const spec = await response.json<{ servers: { url: string }[]; paths: Record<string, unknown> }>();
  expect(spec.servers).toEqual([{ url: "https://card-dev.keepr.digital/api" }]);
  expect(spec.paths).toHaveProperty("/v1/games");
  expect(spec.paths).toHaveProperty("/docs");
  expect(spec.paths).toHaveProperty("/openapi.json");
  expect((await apiWorker.fetch(new Request("https://alternate.invalid/api/v1/games"), env)).status).toBe(401);
});

test.each(["https://card.keepr.digital/api", "https://card-staging.keepr.digital/api/", "http://localhost:8787/"])(
  "documentation advertises the configured base %s without trusting the incoming host",
  async (base) => {
    const mount = new URL(base).pathname.replace(/\/+$/u, "");
    const environment = { ...testEnv, PUBLIC_BASE_URL: base };
    const response = await apiWorker.fetch(new Request(`https://alternate.invalid${mount}/openapi.json`), environment);
    expect(response.status).toBe(200);
    expect((await response.json<{ servers: object[] }>()).servers).toEqual([{ url: base.replace(/\/+$/u, "") }]);
    if (mount) {
      const outside = await apiWorker.fetch(new Request("https://alternate.invalid/openapi.json"), environment);
      expect(outside.status).toBe(404);
    }
    const head = await apiWorker.fetch(
      new Request(`https://alternate.invalid${mount}/docs`, { method: "HEAD" }),
      environment,
    );
    expect(head.status).toBe(401);
    expect(await head.text()).toBe("");
  },
);

test("public documentation preserves consumer origin restrictions and bodyless preflight", async () => {
  const origin = "https://untrusted.example";
  const page = await apiWorker.fetch(new Request("https://alternate.invalid/docs", { headers: { origin } }), testEnv);
  expect(page.status).toBe(200);
  const data = await apiWorker.fetch(
    new Request("https://alternate.invalid/v1/games", { headers: { origin } }),
    testEnv,
  );
  expect(data.status).toBe(403);
  const preflight = await apiWorker.fetch(
    new Request("https://alternate.invalid/v1/games", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "Authorization",
      },
    }),
    testEnv,
  );
  expect(preflight.status).toBe(204);
  await assertHttpResponse(contract, "/*", "options", preflight);
});
