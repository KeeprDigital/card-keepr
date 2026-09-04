import assert from "node:assert/strict";
import { test } from "vitest";
import { deterministicGzip, deterministicGzipStream } from "../../src/catalogue/shared/export-compression.ts";
import {
  verifyComponentExportRecord,
  verifyExportManifest,
  verifyExportRecord,
} from "../../src/catalogue/export-validation.ts";

const goldenInput = new TextEncoder().encode('{"id":"golden"}\n');
const goldenHex = "1f8b08000000000002ffab56ca4c51b2524acfcf4949cd53aae50200cc28fff510000000";

test("buffered and streaming export compression share exact golden bytes", async () => {
  const chunks = [goldenInput.slice(0, 3), goldenInput.slice(3, 11), goldenInput.slice(11)];
  const stream = new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const streamed = new Uint8Array(await new Response(deterministicGzipStream(stream)).arrayBuffer());
  assert.equal(Buffer.from(deterministicGzip(goldenInput)).toString("hex"), goldenHex);
  assert.equal(Buffer.from(streamed).toString("hex"), goldenHex);
});

test("component export validation rejects a valid record from the wrong component", () => {
  const supportedGame = {
    type: "supported_game",
    id: "game_one-piece",
    key: "one-piece",
    name: "One Piece Card Game",
    supported_locales: ["EN-OCEANIA"],
    game_profile: "one-piece@1",
  };
  assert.doesNotThrow(() => verifyExportRecord(supportedGame));
  assert.throws(
    () =>
      verifyComponentExportRecord(
        "https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/ProductRecord",
        supportedGame,
      ),
    /component record failed schema verification/u,
  );
});

test("Legality Rule component validation enforces effect and contextual scope invariants", () => {
  const uri = "https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/LegalityRuleRecord";
  const pointer = "/observations/0/value/legality_rules/0";
  const base = {
    type: "legality_rule",
    id: "rule_schema_contract",
    official_id: "RULE-SCHEMA-CONTRACT",
    game: "fusion-world",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    unresolved_scope: null,
    kind: "eligible",
    effect: { type: "eligible" },
    card_ids: ["card_schema_contract"],
    official_wording: "FB01-001 is eligible for Standard play.",
    source_lineage: "fusion-world-en",
    source_observation_ids: ["srcobs_schema_contract"],
    source_observation_pointer: pointer,
    source_field_pointers: Object.fromEntries(
      [
        "official_wording",
        "effective_from",
        "effective_until",
        "unresolved_scope",
        "region",
        "format",
        "event_tier",
        "card_numbers",
        "effect",
      ].map((field) => [field, `${pointer}/${field}`]),
    ),
    lifecycle: {
      first_revision_id: "catrev_schema_contract",
      last_observed_revision_id: "catrev_schema_contract",
      current: true,
      last_missing_revision_id: null,
    },
  };
  const effectKinds = [
    [{ type: "eligible" }, "eligible"],
    [{ type: "ban" }, "not_legal"],
    [{ type: "copy_limit", maximum_copies: 1 }, "restricted"],
    [{ type: "prohibited_combination", with_card_ids: ["card_companion"] }, "combination"],
    [{ type: "membership", attribute: "traits", includes_any: ["Saiyan"] }, "conditional"],
    [{ type: "rotation", eligible_blocks: ["01"] }, "rotation"],
    [{ type: "release_timing", legal_from: "2026-02-01" }, "release"],
    [{ type: "unresolved", reason: "Publisher context is unclear." }, "indeterminate"],
  ];
  for (const [effect, kind] of effectKinds) {
    assert.doesNotThrow(
      () =>
        verifyComponentExportRecord(uri, {
          ...base,
          kind,
          effect,
        }),
      `${effect.type} / ${kind}`,
    );
    assert.throws(
      () =>
        verifyComponentExportRecord(uri, {
          ...base,
          kind: kind === "eligible" ? "restricted" : "eligible",
          effect,
        }),
      /component record failed schema verification/u,
      `${effect.type} mismatch`,
    );
  }

  const invalid = [
    { ...base, effective_from: null },
    {
      ...base,
      unresolved_scope: { dimensions: ["effective_interval"] },
    },
    {
      ...base,
      kind: "indeterminate",
      effect: { type: "unresolved", reason: "Unknown interval." },
      unresolved_scope: { dimensions: ["effective_interval"] },
      effective_from: "2026-01-01",
    },
    {
      ...base,
      kind: "indeterminate",
      effect: { type: "unresolved", reason: "Unknown interval." },
      unresolved_scope: { dimensions: ["effective_interval"] },
      effective_from: null,
      effective_until: "2026-02-01",
    },
    {
      ...base,
      kind: "indeterminate",
      effect: { type: "unresolved", reason: "Unknown tier." },
      unresolved_scope: { dimensions: ["event_tier"] },
      event_tier: "championship",
    },
    {
      ...base,
      kind: "indeterminate",
      effect: { type: "unresolved", reason: "Unknown interval." },
      unresolved_scope: { dimensions: ["effective_interval"] },
      effective_from: null,
      card_ids: [],
    },
    {
      ...base,
      kind: "combination",
      effect: { type: "prohibited_combination", with_card_ids: ["card_companion"] },
      card_ids: [],
    },
    {
      ...base,
      kind: "indeterminate",
      effect: { type: "unresolved", reason: "Unknown context." },
      unresolved_scope: { dimensions: ["event_tier", "effective_interval"] },
      effective_from: null,
    },
  ];
  for (const record of invalid) {
    assert.throws(() => verifyComponentExportRecord(uri, record), /component record failed schema verification/u);
  }
});

const recordSchemaUri = "https://card-keepr.invalid/schemas/catalogue-export-record@5";

test("printing-image records reference the image by identifier and carry no URL", () => {
  const image = {
    type: "printing_image",
    id: "image_front",
    printing_id: "printing_1",
    role: "front",
    media_type: "image/webp",
    width: 600,
    height: 838,
    content_sha256: "a".repeat(64),
  };
  assert.doesNotThrow(() => verifyComponentExportRecord(`${recordSchemaUri}#/$defs/PrintingImageRecord`, image));
  for (const [content_url, cause] of [
    ["/v1/printing-images/image_front/content", /embeds an API link/u],
    ["https://card.keepr.digital/api/v1/printing-images/image_front/content", /embeds an API link/u],
    ["image_front", /component record failed schema verification/u],
  ]) {
    assert.throws(
      () => verifyComponentExportRecord(`${recordSchemaUri}#/$defs/PrintingImageRecord`, { ...image, content_url }),
      cause,
    );
  }
});

test("manifest components reference their bytes by name and carry no URL", () => {
  const components = [
    ["supported-games", "SupportedGameRecord", "id:utf8"],
    ["game-profiles", "GameProfileRecord", "profile:utf8"],
    ["cards", "CardRecord", "id:utf8"],
    ["printings", "PrintingRecord", "id:utf8"],
    ["printing-images", "PrintingImageRecord", "id:utf8"],
    ["products", "ProductRecord", "id:utf8"],
    ["releases", "ReleaseRecord", "id:utf8"],
    ["distribution-contexts", "DistributionContextRecord", "id:utf8"],
    ["errata", "ErratumRecord", "id:utf8"],
    ["legality-rules", "LegalityRuleRecord", "id:utf8"],
    ["relationships", "RelationshipRecord", "id:utf8"],
  ].map(([name, definition, order]) => ({
    name,
    media_type: "application/x-ndjson",
    compression: "gzip",
    record_schema: `${recordSchemaUri}#/$defs/${definition}`,
    order,
    records: 0,
    uncompressed_bytes: 0,
    content_sha256: "b".repeat(64),
    compressed_bytes: 20,
    compressed_sha256: "c".repeat(64),
  }));
  const manifest = {
    format: "card-keepr-catalogue-export-manifest@5",
    serialization_profile: "card-keepr-ndjson-gzip@1",
    export_schema_major: 5,
    catalogue_revision: { id: "catrev_1", content_sha256: "d".repeat(64) },
    published_at: "2026-09-04T00:00:00.000Z",
    export_created_at: "2026-09-04T00:00:00.000Z",
    supported_games: ["one-piece"],
    source_freshness: [],
    components,
    manifest_sha256: "e".repeat(64),
  };
  assert.doesNotThrow(() => verifyExportManifest(manifest));
  for (const [content_url, cause] of [
    [(name) => `/v1/catalogue-exports/catrev_1/components/${name}`, /embeds an API link/u],
    [
      (name) => `https://card.keepr.digital/api/v1/catalogue-exports/catrev_1/components/${name}`,
      /embeds an API link/u,
    ],
    [(name) => name, /manifest failed schema verification/u],
  ]) {
    assert.throws(
      () =>
        verifyExportManifest({
          ...manifest,
          components: components.map((component) => ({
            ...component,
            content_url: content_url(component.name),
          })),
        }),
      cause,
    );
  }
});

test("export validation rejects any record that embeds an API link", () => {
  const product = (uri) => ({
    type: "product",
    id: "product_1",
    game: "one-piece",
    official_code: "OP01",
    name: "Romance Dawn",
    curated_provenance: [
      {
        curated_revision_id: "currev_1",
        content_digest: "f".repeat(64),
        target: {
          kind: "field",
          entity_type: "product",
          entity_id: "product_1",
          path: "/name",
        },
        rationale: "Official name confirmed.",
        evidence: [{ kind: "owner_reference", uri, content_digest: "0".repeat(64) }],
        author: "owner",
        reviewed_source_value: "Romance Dawn",
      },
    ],
    lifecycle: {
      first_revision_id: "catrev_1",
      last_observed_revision_id: "catrev_1",
      withdrawn: false,
    },
  });
  const uri = `${recordSchemaUri}#/$defs/ProductRecord`;
  assert.doesNotThrow(() => verifyComponentExportRecord(uri, product("https://example.org/owner-note")));
  for (const link of ["https://card.keepr.digital/api/v1/products/product_1", "/v1/products/product_1"]) {
    assert.throws(() => verifyComponentExportRecord(uri, product(link)), /embeds an API link/u);
    assert.throws(() => verifyExportRecord(product(link)), /embeds an API link/u);
  }
});
