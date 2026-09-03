import assert from "node:assert/strict";
import test from "node:test";
import { runProductionSmoke } from "../scripts/production-smoke.mjs";

test("black-box smoke covers auth, representative reads, retained exports, and stale cursors", async () => {
  const visited = [];
  const revisions = ["catrev-current", "catrev-previous", "catrev-old"].map((revision_id, index) => ({
    revision_id, card_id: `card-${index}`, printing_id: `printing-${index}`,
    search_query: `query-${index}`, card_cursor: `card-cursor-${index}`,
    search_cursor: `search-cursor-${index}`, printing_cursor: `printing-cursor-${index}`,
  }));
  const staleCursor = Buffer.from(JSON.stringify({ revision_id: "catrev-archived" })).toString("base64");
  const result = await runProductionSmoke({
    apiUrl: "https://api.example.invalid", apiKey: "traffic-key",
    currentRevisionId: "catrev-current", revisions,
    printingImageId: "image-1", legalityCardId: "card-1",
    legalityDate: "2026-08-05", legalityFormat: "standard", legalityRegion: "EN-OCEANIA",
    staleCursor, staleRevisionId: "catrev-archived",
  }, async (url, init) => {
    const parsed = new URL(url);
    visited.push(`${parsed.pathname}${parsed.search}`);
    if (init.headers.authorization === "Bearer deliberately-invalid") {
      return new Response(JSON.stringify({ code: "authentication_required" }), { status: 401 });
    }
    const after = parsed.searchParams.get("after");
    const fixture = revisions.find((item) => [item.card_cursor, item.search_cursor, item.printing_cursor].includes(after));
    const revision = fixture?.revision_id ?? (parsed.pathname.includes("catrev-previous") ? "catrev-previous" : parsed.pathname.includes("catrev-old") ? "catrev-old" : "catrev-current");
    const headers = { "content-type": "application/json", "x-catalogue-revision": revision };
    if (after === staleCursor) {
      return new Response(JSON.stringify({ code: "cursor_revision_unavailable" }), { status: 409, headers: { "content-type": "application/problem+json" } });
    }
    const body = parsed.pathname === "/v1/catalogue"
      ? { meta: { catalogue_revision_id: "catrev-current" } }
      : parsed.pathname === "/v1/catalogue-exports/catrev-current"
        ? { data: { components: [{ name: "cards" }] } }
        : parsed.pathname === "/v1/cards" && fixture
          ? { data: [{ id: fixture.card_id }], meta: { catalogue_revision_id: revision } }
          : parsed.pathname === "/v1/printings" && fixture
            ? { data: [{ id: fixture.printing_id }], meta: { catalogue_revision_id: revision } }
            : {};
    return new Response(JSON.stringify(body), { status: 200, headers });
  });
  assert.equal(result.contract, "card-keepr-production-smoke@1");
  assert.ok(visited.includes("/v1/printing-images/image-1/content"));
  assert.ok(visited.includes("/v1/catalogue-exports/catrev-old"));
  assert.ok(visited.includes(`/v1/cards?after=${encodeURIComponent(staleCursor)}`));
  for (const fixture of revisions) {
    assert.ok(visited.includes(`/v1/cards?after=${fixture.card_cursor}`));
    assert.ok(visited.includes(`/v1/cards?q=${fixture.search_query}&after=${fixture.search_cursor}`));
    assert.ok(visited.includes(`/v1/printings?after=${fixture.printing_cursor}`));
  }
});

test("black-box smoke appends route paths to an API base that carries a mount path", async () => {
  const visited = [];
  const revisions = ["catrev-current", "catrev-previous", "catrev-old"].map((revision_id, index) => ({
    revision_id, card_id: `card-${index}`, printing_id: `printing-${index}`,
    search_query: `query-${index}`, card_cursor: `card-cursor-${index}`,
    search_cursor: `search-cursor-${index}`, printing_cursor: `printing-cursor-${index}`,
  }));
  const staleCursor = Buffer.from(JSON.stringify({ revision_id: "catrev-archived" })).toString("base64");
  await runProductionSmoke({
    apiUrl: "https://card.keepr.digital/api/", apiKey: "traffic-key",
    currentRevisionId: "catrev-current", revisions,
    printingImageId: "image-1", legalityCardId: "card-1",
    legalityDate: "2026-08-05", legalityFormat: "standard", legalityRegion: "EN-OCEANIA",
    staleCursor, staleRevisionId: "catrev-archived",
  }, async (url, init) => {
    const parsed = new URL(url);
    visited.push(`${parsed.pathname}${parsed.search}`);
    if (init.headers.authorization === "Bearer deliberately-invalid") {
      return new Response(JSON.stringify({ code: "authentication_required" }), { status: 401 });
    }
    const after = parsed.searchParams.get("after");
    const fixture = revisions.find((item) => [item.card_cursor, item.search_cursor, item.printing_cursor].includes(after));
    const revision = fixture?.revision_id ?? (parsed.pathname.includes("catrev-previous") ? "catrev-previous" : parsed.pathname.includes("catrev-old") ? "catrev-old" : "catrev-current");
    const headers = { "content-type": "application/json", "x-catalogue-revision": revision };
    if (after === staleCursor) {
      return new Response(JSON.stringify({ code: "cursor_revision_unavailable" }), { status: 409, headers: { "content-type": "application/problem+json" } });
    }
    const body = parsed.pathname === "/api/v1/catalogue"
      ? { meta: { catalogue_revision_id: "catrev-current" } }
      : parsed.pathname === "/api/v1/catalogue-exports/catrev-current"
        ? { data: { components: [{ name: "cards" }] } }
        : parsed.pathname === "/api/v1/cards" && fixture
          ? { data: [{ id: fixture.card_id }], meta: { catalogue_revision_id: revision } }
          : parsed.pathname === "/api/v1/printings" && fixture
            ? { data: [{ id: fixture.printing_id }], meta: { catalogue_revision_id: revision } }
            : {};
    return new Response(JSON.stringify(body), { status: 200, headers });
  });
  assert.equal(visited[0], "/api/health");
  assert.ok(visited.includes("/api/v1/catalogue"));
  assert.ok(visited.includes("/api/v1/printing-images/image-1/content"));
  assert.ok(visited.includes("/api/v1/catalogue-exports/catrev-current/components/cards"));
  assert.ok(visited.every((path) => path.startsWith("/api/")));
  assert.ok(visited.every((path) => !path.startsWith("/api//")));
});

test("black-box smoke rejects missing retained or stale fixtures before traffic", async () => {
  let calls = 0;
  await assert.rejects(runProductionSmoke({ apiUrl: "https://api.example.invalid", apiKey: "key", revisions: [] }, async () => {
    calls += 1;
    return new Response();
  }), /invalid_smoke_input/u);
  assert.equal(calls, 0);
});
