import assert from "node:assert/strict";
import test from "node:test";
import { runProductionSmoke } from "../scripts/production-smoke.mjs";

test("black-box smoke covers auth, representative reads, retained exports, and stale cursors", async () => {
  const visited = [];
  const result = await runProductionSmoke({
    apiUrl: "https://api.example.invalid", apiKey: "traffic-key",
    currentRevisionId: "catrev-current", cardId: "card-1", printingId: "printing-1",
    printingImageId: "image-1", searchQuery: "alpha", legalityCardId: "card-1",
    legalityDate: "2026-08-05", legalityFormat: "standard", legalityRegion: "EN-OCEANIA",
    retainedRevisionIds: ["catrev-current", "catrev-previous", "catrev-old"],
    staleCursor: "stale-cursor",
  }, async (url, init) => {
    const parsed = new URL(url);
    visited.push(`${parsed.pathname}${parsed.search}`);
    if (init.headers.authorization === "Bearer deliberately-invalid") {
      return new Response(JSON.stringify({ code: "authentication_required" }), { status: 401 });
    }
    const revision = parsed.pathname.includes("catrev-previous") ? "catrev-previous" : parsed.pathname.includes("catrev-old") ? "catrev-old" : "catrev-current";
    const headers = { "content-type": "application/json", "x-catalogue-revision": revision };
    if (parsed.searchParams.get("after") === "stale-cursor") {
      return new Response(JSON.stringify({ code: "cursor_revision_unavailable" }), { status: 409, headers: { "content-type": "application/problem+json" } });
    }
    const body = parsed.pathname === "/v1/catalogue"
      ? { meta: { catalogue_revision_id: "catrev-current" } }
      : parsed.pathname === "/v1/catalogue-exports/catrev-current"
        ? { data: { components: [{ name: "cards" }] } }
        : {};
    return new Response(JSON.stringify(body), { status: 200, headers });
  });
  assert.equal(result.contract, "card-keepr-production-smoke@1");
  assert.ok(visited.includes("/v1/printing-images/image-1/content"));
  assert.ok(visited.includes("/v1/catalogue-exports/catrev-old"));
  assert.ok(visited.includes("/v1/cards?after=stale-cursor"));
});
