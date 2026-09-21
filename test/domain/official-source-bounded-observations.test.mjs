import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/catalogue/shared/index.ts";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import { retainedRestructuredParse, restructuredStageDigest } from "./official-source-raw-contract-shared.mjs";

// The bounded source intake retains one observation at a time: at most
// 512,000 canonical bytes (source-record-intake.ts) and 16,384 JSON nodes
// (source-record-text.ts) per observation, counting every value once. A full
// publisher page must satisfy both by construction, whatever the page size.
const maximumObservationBytes = 512_000;
const maximumObservationNodes = 16_384;
function nodes(value) {
  let count = 1;
  if (Array.isArray(value)) for (const item of value) count += nodes(item);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) count += nodes(item);
  return count;
}
const fullPages = [
  {
    label: "One Piece OP16 series page (155 cards, live 2026-09-21)",
    adapter: "one-piece-en@6",
    slug: "one-piece-en-card-list-op16-series",
    context: (adapter) => ({ url: adapter.requestUrlForSurface("card-list"), requestId: "one-piece-en:card-list" }),
    observations: 155,
  },
  {
    label: "One Piece OP16 discovery root (155 cards, 2026-08-07)",
    adapter: "one-piece-en@6",
    slug: "one-piece-en-restructured-discovery",
    context: (adapter) => ({ url: adapter.requestUrlForSurface("card-list"), requestId: "one-piece-en:card-list" }),
    observations: 155,
  },
  {
    label: "Fusion World card search category leaf (172 cards)",
    adapter: "fusion-world-en@9",
    slug: "fusion-world-en-restructured-card-search",
    context: (adapter) => ({
      url: adapter.requestUrlForSurface("card-search"),
      requestId: "fusion-world-en:card-search",
    }),
    observations: 172,
  },
  {
    label: "Digimon BT-01 blue leaf listing (24 cards)",
    adapter: "digimon-en@7",
    slug: "digimon-en-card-list-bt01-leaf",
    context: () => ({
      url: "https://world.digimoncard.com/cards/index.php?search=true&category=522001&cardcategory=Digimon&color=Blue",
      requestId: `digimon-en:listing:${restructuredStageDigest}`,
    }),
    observations: 24,
  },
  {
    label: "Gundam Asia package listing (187 declared)",
    adapter: "gundam-en-asia@7",
    slug: "gundam-en-asia-card-list-complete-live",
    context: () => ({
      url: "https://www.gundam-gcg.com/asia-en/cards/index.php?package=619102",
      requestId: `gundam-en-asia:listing:${"d".repeat(64)}`,
    }),
    observations: 1,
  },
];

for (const page of fullPages) {
  test(`${page.label} keeps every observation within the bounded intake`, () => {
    const adapter = requiredSourceAdapter(page.adapter);
    const { observations } = retainedRestructuredParse(adapter, page.slug, page.context(adapter));
    assert.equal(observations.length, page.observations);
    for (const [index, observation] of observations.entries()) {
      const bytes = Buffer.byteLength(canonicalJson(observation));
      assert.ok(bytes <= maximumObservationBytes, `${page.slug} observation ${index} is ${bytes} bytes`);
      const count = nodes(observation);
      assert.ok(count <= maximumObservationNodes, `${page.slug} observation ${index} has ${count} nodes`);
    }
  });
}

test("a One Piece series page retains its surface document once as a digest-verified auxiliary text", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const { observations } = retainedRestructuredParse(adapter, "one-piece-en-card-list-op16-series", {
    url: adapter.requestUrlForSurface("card-list"),
    requestId: "one-piece-en:card-list",
  });
  const [first, second] = observations;
  const [surface] = first.source_sidecar.raw.official_surfaces;
  assert.equal(surface.source_lineage, "one-piece-en");
  assert.equal(surface.surface, "card-list");
  assert.equal(surface.document, undefined);
  assert.equal(typeof surface.document_json, "string");
  assert.equal(createHash("sha256").update(surface.document_json).digest("hex"), surface.document_sha256);
  assert.equal(Buffer.byteLength(surface.document_json), surface.document_byte_length);
  const document = JSON.parse(surface.document_json);
  assert.equal(document.page, "card-list");
  assert.equal(document.declared_record_count, 155);
  assert.equal(document.recording_options.length, 60);
  assert.ok(first.source_sidecar.consumed_fields.includes("source_sidecar.raw.official_surfaces[].document_json"));
  // The page's leaves are not enumerated into the observation: each Card
  // observation carries its own retained detail and unfamiliar fields.
  assert.ok(first.source_sidecar.unmapped_optional_fields.length < 64);
  assert.deepEqual(second.source_sidecar.raw.official_surfaces, [
    { source_lineage: "one-piece-en", surface: "card-list", retained_by_observation_ordinal: 1 },
  ]);
});

test("a small surface document stays inline with its enumerated field coverage", () => {
  const adapter = requiredSourceAdapter("gundam-en-asia@7");
  const { observations } = retainedRestructuredParse(adapter, "gundam-en-asia-card-list-complete-live", {
    url: "https://www.gundam-gcg.com/asia-en/cards/index.php?package=619102",
    requestId: `gundam-en-asia:listing:${"d".repeat(64)}`,
  });
  const [surface] = observations[0].source_sidecar.raw.official_surfaces;
  assert.equal(surface.document_json, undefined);
  assert.equal(typeof surface.document, "object");
  assert.equal("terminal_page" in surface.document, true);
});
