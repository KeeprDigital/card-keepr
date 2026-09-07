import assert from "node:assert/strict";
import { test } from "vitest";
import {
  verifyComponentExportRecord,
  verifyExportManifest,
  verifyExportRecord,
} from "../../src/catalogue/export/export-validation.ts";
import { deterministicGzip, deterministicGzipStream } from "../../src/catalogue/shared/export-compression.ts";

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

test("eligibility records are not a consumer export component", () => {
  assert.throws(
    () =>
      verifyComponentExportRecord(
        "https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/LegalityRuleRecord",
        { type: "legality_rule", id: "removed" },
      ),
    /unresolved record_schema/u,
  );
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
    ["supported-games", "SupportedGameRecord"],
    ["game-profiles", "GameProfileRecord"],
    ["cards", "CardRecord"],
    ["releases", "ReleaseRecord"],
  ].map(([kind, definition], ordinal) => ({
    name: `one-piece.${ordinal}`,
    kind,
    media_type: "application/x-ndjson",
    compression: "gzip",
    record_schema: `${recordSchemaUri}#/$defs/${definition}`,
    records: 1,
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
    components,
    page: { next_cursor: null },
    manifest_sha256: "e".repeat(64),
  };
  assert.doesNotThrow(() => verifyExportManifest(manifest));
  assert.throws(
    () => verifyExportManifest({ ...manifest, components: [...components, { ...components[0], name: "one-piece.4" }] }),
    /manifest failed schema verification/u,
  );
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
    name: uri,
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
