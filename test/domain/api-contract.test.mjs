import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { test } from "vitest";
import { installedSourceAdapterRegistrations } from "../../src/catalogue/adapters/source-adapters.ts";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue.ts";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence.ts";

const root = resolve(import.meta.dirname, "../..");

test("Catalogue Export relationship records carry closed endpoints", async () => {
  const record = JSON.parse(
    await readFile(resolve(root, "contracts/schemas", "catalogue-export-record-v5.schema.json"), "utf8"),
  );

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(record);
  const validateRelationship = ajv.getSchema(`${record.$id}#/$defs/RelationshipRecord`);
  const endpointCases = [
    ["printing-distribution-context", "printing", "distribution_context"],
    ["printing-product", "printing", "product"],
    ["distribution-context-product", "distribution_context", "product"],
    ["product-card", "product", "card"],
    ["erratum-target", "erratum", "printing"],
  ];
  for (const [kind, from, to] of endpointCases) {
    assert.equal(
      validateRelationship({
        type: "relationship",
        id: `relationship_${kind}`,
        kind,
        from: { type: from, id: "from_1" },
        to: { type: to, id: "to_1" },
        relationship_value: "value",
        lifecycle: {
          first_revision_id: "catrev_1",
          last_observed_revision_id: "catrev_1",
          current: true,
          last_missing_revision_id: null,
        },
      }),
      true,
      `${kind}: ${ajv.errorsText(validateRelationship.errors)}`,
    );
  }
  assert.equal(
    validateRelationship({
      type: "relationship",
      id: "relationship_wrong_pair",
      kind: "product-card",
      from: { type: "printing", id: "from_1" },
      to: { type: "card", id: "to_1" },
      relationship_value: "value",
      lifecycle: {
        first_revision_id: "catrev_1",
        last_observed_revision_id: "catrev_1",
        current: true,
        last_missing_revision_id: null,
      },
    }),
    false,
  );
});

test("Product detail documents invalid include requests", async () => {
  const openapi = JSON.parse(await readFile(resolve(root, "contracts/openapi.json"), "utf8"));
  assert.deepEqual(openapi.paths["/products/{product_id}"].get.responses["400"], {
    $ref: "#/components/responses/InvalidRequest",
  });
});

test("consumer OpenAPI omits eligibility routes", async () => {
  const openapi = JSON.parse(await readFile(resolve(root, "contracts/openapi.json"), "utf8"));
  assert.equal(Object.hasOwn(openapi.paths, "/legality-status"), false);
});

test("Card browsing documents and validates collection, detail, and problem representations", async () => {
  const [openapi, schema] = await Promise.all([
    readFile(resolve(root, "contracts/openapi.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "contracts/schemas/api.schema.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(openapi.paths["/cards"].get.responses["200"].content["application/json"].schema, {
    $ref: "./schemas/api.schema.json#/$defs/CardCollection",
  });
  assert.deepEqual(openapi.paths["/cards"].get.responses["400"], {
    $ref: "#/components/responses/InvalidRequest",
  });
  assert.deepEqual(openapi.paths["/cards"].get.responses["409"], {
    $ref: "#/components/responses/CursorUnavailable",
  });
  assert.deepEqual(openapi.paths["/cards/{card_id}"].get.responses["200"].content["application/json"].schema, {
    $ref: "./schemas/api.schema.json#/$defs/CardDocument",
  });

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validateCollection = ajv.getSchema(`${schema.$id}#/$defs/CardCollection`);
  const validateDetail = ajv.getSchema(`${schema.$id}#/$defs/CardDocument`);
  const validateProblem = ajv.getSchema(`${schema.$id}#/$defs/Problem`);
  const card = {
    type: "card",
    id: "card_test",
    game: "one-piece",
    official_identity: { kind: "card_number", value: "OP01-001" },
    name: "Test Card",
    game_data: { profile: "one-piece@1", attributes: {} },
    lifecycle: {
      first_revision_id: "catrev_test",
      last_observed_revision_id: "catrev_test",
      withdrawn: false,
    },
    links: { self: "/v1/cards/card_test" },
  };
  const meta = {
    catalogue_revision_id: "catrev_test",
    published_at: "2026-08-01T00:00:00.000Z",
  };
  assert.equal(
    validateCollection({
      data: [card],
      meta,
      page: { limit: 50, next_cursor: null },
      links: { self: "/v1/cards" },
    }),
    true,
    JSON.stringify(validateCollection.errors),
  );

  const detail = {
    data: { ...card, effective_rules_text: null, printing_ids: [] },
    meta,
    links: { self: "/v1/cards/card_test" },
  };
  assert.equal(validateDetail(detail), true, JSON.stringify(validateDetail.errors));
  assert.equal(validateDetail({ ...detail, included: [] }), true, JSON.stringify(validateDetail.errors));
  assert.equal(
    validateDetail({
      ...detail,
      provenance: { "/data/effective_rules_text": ["srcobs_test"] },
    }),
    false,
    "consumer provenance is not supported",
  );

  assert.equal(
    validateProblem({
      type: "/problems/cursor-revision-unavailable",
      title: "Cursor Revision Unavailable",
      status: 409,
      code: "cursor_revision_unavailable",
      detail: "Restart browsing from the current revision.",
      request_id: "req_test",
      links: { collection: "/v1/cards" },
    }),
    true,
    JSON.stringify(validateProblem.errors),
  );
});

test("the Catalogue Export schema carries typed Product and Release facts without evidence projections", async () => {
  const [api, exportSchema, exportManifest] = await Promise.all(
    ["api.schema.json", "catalogue-export-record-v5.schema.json", "catalogue-export-manifest-v5.schema.json"].map(
      async (name) => JSON.parse(await readFile(resolve(root, "contracts/schemas", name), "utf8")),
    ),
  );
  assert.equal(api.$defs.Printing.required.includes("products"), false);
  assert.equal(api.$defs.Printing.required.includes("distribution_contexts"), true);
  assert.deepEqual(api.$defs.Product.properties.name.oneOf, [{ type: "string", minLength: 1 }, { type: "null" }]);
  assert.equal(api.$defs.Release.required.includes("event_key"), true);
  assert.equal(api.$defs.Release.required.includes("status"), true);
  assert.equal(Object.hasOwn(api.$defs.PrintingProductProjection.properties, "source_observation_ids"), false);
  assert.equal(Object.hasOwn(api.$defs.DistributionContext.properties, "source_observation_ids"), false);
  assert.equal(exportSchema.$defs.PrintingRecord.required.includes("products"), false);
  assert.equal(exportSchema.$defs.PrintingRecord.required.includes("distribution_contexts"), false);
  assert.equal(exportSchema.$defs.ProductRecord.properties.name.$ref, "#/$defs/NullableText");
  assert.equal(exportSchema.$defs.SupportedGameRecord.properties.name.minLength, 1);
  assert.equal(exportSchema.$id.endsWith("catalogue-export-record@5"), true);
  assert.equal(exportManifest.$id.endsWith("catalogue-export-manifest@5"), true);
  assert.equal(exportManifest.properties.export_schema_major.const, 5);
  assert.equal(exportSchema.$defs.ReleaseRecord.required.includes("event_key"), true);
  assert.equal(exportSchema.$defs.ReleaseRecord.required.includes("status"), true);
  assert.ok(
    exportManifest.$defs.Component.properties.record_schema.enum.includes(`${exportSchema.$id}#/$defs/ReleaseRecord`),
  );
  for (const definition of ["PrintingProductProjection", "PrintingDistributionContextProjection"]) {
    assert.equal(Object.hasOwn(exportSchema.$defs[definition].properties, "source_observation_ids"), false);
  }
});

test("the current schema registers exactly the installed adapter versions immutably", async () => {
  // The seed rows must equal installedSourceAdapterRegistrations in
  // src/catalogue/adapters/source-adapters.ts. Before Go-Live (ADR 0008) each Source
  // Lineage registers exactly one production raw version and a capacity
  // change edits its row in place (#134, #135).
  const expected = installedSourceAdapterRegistrations
    .map((adapter) => ({
      adapter_version: adapter.adapterVersion,
      source_lineage: adapter.sourceLineage,
      supported_game: adapter.supportedGame,
      game_profile_version: adapter.gameProfileVersion,
      parser_contract: adapter.parserContract,
      adapter_origin: adapter.origin,
      request_capacity: adapter.requestCapacity,
    }))
    .sort((left, right) => left.adapter_version.localeCompare(right.adapter_version));
  const assertVersionSet = (database) => {
    const versions = sourceEvidenceQueries
      .readSourceAdapterVersionsAdapterVersionSourceLineage(database)
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(versions, expected);
    assert.deepEqual(
      versions
        .filter(
          ({ adapter_version }) =>
            /^(one-piece-en|fusion-world-en|digimon-en|gundam-en-asia|gundam-en-us)@\d+$/u.test(adapter_version) &&
            !/-card-document@1$/u.test(versions.find((row) => row.adapter_version === adapter_version).parser_contract),
        )
        .map(({ adapter_version, request_capacity }) => [adapter_version, request_capacity]),
      [
        ["digimon-en@7", 5000],
        ["fusion-world-en@9", 15000],
        ["gundam-en-asia@7", 5000],
        ["gundam-en-us@7", 5000],
        ["one-piece-en@6", 10000],
      ],
    );
    assert.throws(
      () =>
        database.exec(
          `UPDATE source_adapter_versions
           SET parser_contract = 'mutated'
           WHERE adapter_version = 'one-piece-en@6'`,
        ),
      /source_adapter_version_immutable/u,
    );
    assert.deepEqual(publishedCatalogueQueries.inspectForeignKeyCheck(database).all(), []);
    assert.equal(publishedCatalogueQueries.inspectIntegrityCheck(database).get().integrity_check, "ok");
  };

  const fresh = new DatabaseSync(":memory:");
  for (const migration of (await readdir(resolve(root, "migrations"))).filter((file) => file.endsWith(".sql")).sort()) {
    fresh.exec(await readFile(resolve(root, "migrations", migration), "utf8"));
  }
  assertVersionSet(fresh);
  fresh.close();
});
