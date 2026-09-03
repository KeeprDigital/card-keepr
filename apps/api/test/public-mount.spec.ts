import { expect, test } from "vitest";
import apiWorker from "../src/index";
import {
  apiCard,
  apiHeaders,
  installApiSuite,
  seedApiRevision,
  testEnv,
} from "./api-fixtures";

installApiSuite();

// Issue #123: production mounts the API at https://card.keepr.digital/api.
// The mount is derived from PUBLIC_BASE_URL alone, so this suite overrides
// the var per request while every other spec keeps the root-mounted base.
const publicBase = "https://card.keepr.digital/api";
const mountedEnv = { ...testEnv, PUBLIC_BASE_URL: publicBase };

function mountedRequest(path: string, init?: RequestInit): Promise<Response> {
  return apiWorker.fetch(
    new Request(`https://card.keepr.digital${path}`, {
      headers: apiHeaders("198.51.100.23"),
      ...init,
    }),
    mountedEnv,
  );
}

function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(atob(cursor)) as Record<string, unknown>;
}

test("the health route answers under the mount and nowhere else", async () => {
  const mounted = await mountedRequest("/api/health");
  expect(mounted.status).toBe(200);
  await expect(mounted.json()).resolves.toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "api",
    status: "ok",
  });

  const root = await mountedRequest("/health");
  expect(root.status).toBe(404);
  expect(root.headers.get("content-type")).toBe("application/problem+json");
  await expect(root.json()).resolves.toMatchObject({ code: "not_found" });
});

test("requests outside the mount are refused before authentication", async () => {
  const anonymous = await apiWorker.fetch(
    new Request("https://card.keepr.digital/v1/cards"),
    mountedEnv,
  );
  expect(anonymous.status).toBe(404);
  await expect(anonymous.json()).resolves.toMatchObject({ code: "not_found" });

  const mountedAnonymous = await apiWorker.fetch(
    new Request("https://card.keepr.digital/api/v1/cards"),
    mountedEnv,
  );
  expect(mountedAnonymous.status).toBe(401);
});

test("the exact mount path routes as the worker root", async () => {
  for (const path of ["/api", "/api/"]) {
    const response = await mountedRequest(path);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "not_found",
    });
  }
});

test("the catalogue document links are absolute public URLs", async () => {
  const response = await mountedRequest("/api/v1/catalogue");
  expect(response.status).toBe(200);
  const document = await response.json<{
    data: { current_revision_id: string; current_export: string };
    links: Record<string, string>;
  }>();
  expect(document.data.current_export).toBe(
    `${publicBase}/v1/catalogue-exports/${document.data.current_revision_id}`,
  );
  expect(document.links).toEqual({
    self: `${publicBase}/v1/catalogue`,
    cards: `${publicBase}/v1/cards`,
    printings: `${publicBase}/v1/printings`,
    products: `${publicBase}/v1/products`,
    catalogue_exports: `${publicBase}/v1/catalogue-exports`,
  });
});

test("card collection pages carry absolute self links and mount-free cursors", async () => {
  await seedApiRevision({
    revisionId: "catrev_public_mount",
    runId: "run_public_mount",
    cards: [
      apiCard({ id: "card_mount_a", cardNumber: "OP01-001", name: "Alpha" }),
      apiCard({ id: "card_mount_b", cardNumber: "OP01-002", name: "Beta" }),
    ],
  });

  const first = await mountedRequest("/api/v1/cards?limit=1");
  expect(first.status).toBe(200);
  const page = await first.json<{
    data: { id: string; links: { self: string } }[];
    page: { next_cursor: string | null };
    links: { self: string };
  }>();
  expect(page.links.self).toBe(`${publicBase}/v1/cards?limit=1`);
  expect(page.data).toHaveLength(1);
  expect(page.data[0]!.links.self).toBe(
    `${publicBase}/v1/cards/${page.data[0]!.id}`,
  );
  expect(page.page.next_cursor).not.toBeNull();
  expect(decodeCursor(page.page.next_cursor!)).toMatchObject({
    route: "/v1/cards",
  });

  const second = await mountedRequest(
    `/api/v1/cards?limit=1&after=${encodeURIComponent(page.page.next_cursor!)}`,
  );
  expect(second.status).toBe(200);
  const next = await second.json<{
    data: { id: string }[];
    links: { self: string };
  }>();
  expect(next.data.map(({ id }) => id)).toEqual(["card_mount_b"]);
  expect(next.links.self).toBe(
    `${publicBase}/v1/cards?limit=1&after=${encodeURIComponent(page.page.next_cursor!)}`,
  );

  const stale = await mountedRequest(
    `/api/v1/cards?limit=1&after=${encodeURIComponent(
      btoa(JSON.stringify({
        ...decodeCursor(page.page.next_cursor!),
        revision_id: "catrev_never_published",
      })),
    )}`,
  );
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    code: "cursor_revision_unavailable",
    links: { collection: `${publicBase}/v1/cards` },
  });
});

test("card detail documents rewrite stored links to the public base", async () => {
  await seedApiRevision({
    revisionId: "catrev_public_mount_detail",
    runId: "run_public_mount_detail",
    cards: [
      apiCard({ id: "card_mount_detail", cardNumber: "OP01-003", name: "Gamma" }),
    ],
  });
  const response = await mountedRequest(
    "/api/v1/cards/card_mount_detail?include=printings",
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: {
      id: "card_mount_detail",
      links: { self: `${publicBase}/v1/cards/card_mount_detail` },
    },
    links: {
      self: `${publicBase}/v1/cards/card_mount_detail?include=printings`,
    },
  });
});

test("the root-mounted test base keeps every link absolute on the local origin", async () => {
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/catalogue", {
      headers: apiHeaders("198.51.100.24"),
    }),
    testEnv,
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    links: { self: "http://127.0.0.1:8787/v1/catalogue" },
  });
});
