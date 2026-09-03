import { expect, test } from "vitest";
import {
  absoluteDocumentLinks,
  mountedRequest,
  parsePublicBase,
  publicBase,
  publicUrl,
  routePath,
} from "../../src/http/public-base";

const apiBase = parsePublicBase("https://card.keepr.digital/api");
const rootBase = parsePublicBase("http://127.0.0.1:8787");

test("a public base is an origin plus a mount path without a trailing slash", () => {
  expect(apiBase).toEqual({
    origin: "https://card.keepr.digital",
    basePath: "/api",
  });
  expect(parsePublicBase("https://card.keepr.digital/ingest/")).toEqual({
    origin: "https://card.keepr.digital",
    basePath: "/ingest",
  });
  expect(rootBase).toEqual({ origin: "http://127.0.0.1:8787", basePath: "" });
  expect(parsePublicBase("http://127.0.0.1:8788/")).toEqual({
    origin: "http://127.0.0.1:8788",
    basePath: "",
  });
});

test("a public base rejects relative, non-http, or decorated values", () => {
  for (const value of [
    "",
    "/api",
    "card.keepr.digital/api",
    "ftp://card.keepr.digital/api",
    "https://card.keepr.digital/api?x=1",
    "https://card.keepr.digital/api#top",
    "https://user:pw@card.keepr.digital/api",
    undefined,
  ]) {
    expect(() => parsePublicBase(value)).toThrow(/PUBLIC_BASE_URL/u);
  }
});

test("publicBase reads the worker var and reuses the parsed value", () => {
  const env = { PUBLIC_BASE_URL: "https://card.keepr.digital/api" };
  const first = publicBase(env);
  expect(first).toEqual(apiBase);
  expect(publicBase(env)).toBe(first);
  expect(publicBase({ PUBLIC_BASE_URL: "http://127.0.0.1:8787" })).toEqual(
    rootBase,
  );
});

test("a root mount leaves every path unchanged", () => {
  expect(routePath(new URL("http://127.0.0.1:8787/health"), "")).toBe(
    "/health",
  );
  expect(routePath(new URL("http://127.0.0.1:8787/v1/cards?q=x"), "")).toBe(
    "/v1/cards",
  );
  expect(routePath(new URL("http://127.0.0.1:8787/"), "")).toBe("/");
});

test("a path mount strips its prefix and keeps the leading slash", () => {
  const origin = "https://card.keepr.digital";
  expect(routePath(new URL(`${origin}/api/health`), "/api")).toBe("/health");
  expect(routePath(new URL(`${origin}/api/v1/cards?limit=1`), "/api")).toBe(
    "/v1/cards",
  );
  expect(routePath(new URL(`${origin}/api`), "/api")).toBe("/");
  expect(routePath(new URL(`${origin}/api/`), "/api")).toBe("/");
});

test("requests outside the mount are not routed", () => {
  const origin = "https://card.keepr.digital";
  expect(routePath(new URL(`${origin}/health`), "/api")).toBeNull();
  expect(routePath(new URL(`${origin}/v1/cards`), "/api")).toBeNull();
  expect(routePath(new URL(`${origin}/apix/health`), "/api")).toBeNull();
  expect(routePath(new URL(`${origin}/ingest/health`), "/api")).toBeNull();
  expect(routePath(new URL(`${origin}/`), "/api")).toBeNull();
});

test("routing is by path only, whatever origin the request arrived on", () => {
  expect(routePath(new URL("http://127.0.0.1:8787/api/health"), "/api")).toBe(
    "/health",
  );
});

test("public URLs join the base and route path without double slashes", () => {
  expect(publicUrl(apiBase, "/v1/cards")).toBe(
    "https://card.keepr.digital/api/v1/cards",
  );
  expect(publicUrl(apiBase, "/v1/cards?q=luffy&limit=25")).toBe(
    "https://card.keepr.digital/api/v1/cards?q=luffy&limit=25",
  );
  expect(publicUrl(apiBase, "/")).toBe("https://card.keepr.digital/api/");
  expect(publicUrl(rootBase, "/health")).toBe("http://127.0.0.1:8787/health");
  expect(() => publicUrl(apiBase, "v1/cards")).toThrow(/must start with/u);
});

test("a mounted request keeps method, headers, and query on the stripped path", async () => {
  const request = new Request(
    "https://card.keepr.digital/api/v1/cards?limit=2",
    {
      method: "POST",
      headers: { authorization: "Bearer key", "content-type": "text/plain" },
      body: "payload",
    },
  );
  const mounted = mountedRequest(request, "/v1/cards");
  expect(mounted.url).toBe("https://card.keepr.digital/v1/cards?limit=2");
  expect(mounted.method).toBe("POST");
  expect(mounted.headers.get("authorization")).toBe("Bearer key");
  await expect(mounted.text()).resolves.toBe("payload");
  const unchanged = new Request("http://127.0.0.1:8787/health");
  expect(mountedRequest(unchanged, "/health")).toBe(unchanged);
});

test("stored document links become absolute while other fields stay put", () => {
  const document = {
    data: {
      type: "printing",
      id: "printing_1",
      printed_rules_text: "/v1/not-a-link",
      printing_images: [
        {
          id: "image_1",
          links: {
            self: "/v1/printing-images/image_1",
            content: "/v1/printing-images/image_1/content",
          },
        },
      ],
      links: { self: "/v1/printings/printing_1" },
    },
    included: [{ type: "source_observation", id: "obs_1" }],
    links: { self: "/v1/printings/printing_1?include=evidence" },
  };
  expect(absoluteDocumentLinks(document, apiBase)).toEqual({
    data: {
      type: "printing",
      id: "printing_1",
      printed_rules_text: "/v1/not-a-link",
      printing_images: [
        {
          id: "image_1",
          links: {
            self: "https://card.keepr.digital/api/v1/printing-images/image_1",
            content:
              "https://card.keepr.digital/api/v1/printing-images/image_1/content",
          },
        },
      ],
      links: { self: "https://card.keepr.digital/api/v1/printings/printing_1" },
    },
    included: [{ type: "source_observation", id: "obs_1" }],
    links: {
      self:
        "https://card.keepr.digital/api/v1/printings/printing_1?include=evidence",
    },
  });
  const untouched = { data: { id: "x", game_data: { links: 3 } } };
  expect(absoluteDocumentLinks(untouched, apiBase)).toBe(untouched);
});
