import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { installedSourceAdapterRegistrations } from "../../src/catalogue/adapters/source-adapters.ts";

const root = resolve(import.meta.dirname, "../..");

test("Catalogue Export relationship records carry closed endpoints", async () => {
  const record = JSON.parse(
    await readFile(
      resolve(root, "prototype/formalize-implementation-contracts/schemas", "catalogue-export-record-v5.schema.json"),
      "utf8",
    ),
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
    ["legality-rule-card", "legality_rule", "card"],
  ];
  for (const [kind, from, to] of endpointCases) {
    assert.equal(
      validateRelationship({
        type: "relationship",
        id: `relationship_${kind}`,
        kind,
        from: { type: from, id: "from_1" },
        to: { type: to, id: "to_1" },
        evidence_category: "explicit",
        source_lineage: "official-source",
        source_observation_ids: ["srcobs_1"],
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
      evidence_category: "explicit",
      source_lineage: "official-source",
      source_observation_ids: ["srcobs_1"],
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

test("unresolved target-scope exports use schema major 5", async () => {
  const [record, manifest] = await Promise.all(
    ["catalogue-export-record-v5.schema.json", "catalogue-export-manifest-v5.schema.json"].map((name) =>
      readFile(resolve(root, "prototype/formalize-implementation-contracts/schemas", name), "utf8").then(JSON.parse),
    ),
  );
  assert.equal(record.$id.endsWith("catalogue-export-record@5"), true);
  assert.equal(manifest.$id.endsWith("catalogue-export-manifest@5"), true);
  assert.equal(manifest.properties.export_schema_major.const, 5);
  assert.ok(
    manifest.$defs.CardsComponent.allOf[1].properties.record_schema.const.includes("catalogue-export-record@5"),
  );

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(record);
  const validateRule = ajv.getSchema(`${record.$id}#/$defs/LegalityRuleRecord`);
  const rule = (overrides) => ({
    type: "legality_rule",
    id: "legality_rule_target_scope",
    official_id: "target-scope-1",
    game: "gundam",
    region: "EN-ASIA",
    format: "standard",
    event_tier: null,
    effective_from: null,
    effective_until: null,
    unresolved_scope: {
      dimensions: ["effective_interval", "target_scope"],
    },
    kind: "indeterminate",
    effect: {
      type: "unresolved",
      reason: "The published description includes future printings.",
    },
    card_ids: ["card_enumerated"],
    official_wording: "Open predicate wording.",
    source_lineage: "gundam-en-asia",
    source_observation_ids: ["srcobs_1"],
    source_observation_pointer: "/observations/0/value/legality_rules/0",
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
      ].map((field) => [field, `/observations/0/value/legality_rules/0/${field}`]),
    ),
    lifecycle: {
      first_revision_id: "catrev_1",
      last_observed_revision_id: "catrev_1",
      current: true,
      last_missing_revision_id: null,
    },
    ...overrides,
  });
  assert.equal(validateRule(rule({})), true, ajv.errorsText(validateRule.errors));
  assert.equal(
    validateRule(
      rule({
        unresolved_scope: { dimensions: ["target_scope"] },
        effective_from: "2026-01-01",
      }),
    ),
    true,
    ajv.errorsText(validateRule.errors),
  );
  // Non-canonical order, invented dates, and empty targets stay rejected.
  assert.equal(
    validateRule(
      rule({
        unresolved_scope: { dimensions: ["target_scope", "effective_interval"] },
      }),
    ),
    false,
  );
  assert.equal(validateRule(rule({ effective_from: "2026-01-01" })), false);
  assert.equal(validateRule(rule({ card_ids: [] })), false);
  assert.equal(
    validateRule(
      rule({
        kind: "eligible",
        effect: { type: "eligible" },
      }),
    ),
    false,
  );
});

test("Product detail documents invalid include requests", async () => {
  const openapi = JSON.parse(
    await readFile(resolve(root, "prototype/formalize-implementation-contracts/openapi.json"), "utf8"),
  );
  assert.deepEqual(openapi.paths["/products/{product_id}"].get.responses["400"], {
    $ref: "#/components/responses/InvalidRequest",
  });
});

test("Legality Status documents and validates base and evidence representations", async () => {
  const [openapi, schema] = await Promise.all([
    readFile(resolve(root, "prototype/formalize-implementation-contracts/openapi.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "prototype/formalize-implementation-contracts/schemas/api.schema.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const include = openapi.paths["/legality-status"].get.parameters.find((parameter) => parameter.name === "include");
  assert.deepEqual(include?.schema, { type: "string", enum: ["evidence"] });

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/LegalityStatusDocument`);
  const base = {
    data: [
      {
        card_id: "card_test",
        on: "2026-08-01",
        format: "standard",
        event_tier: null,
        region: "EN-ASIA",
        status: "not_legal",
        rule_ids: ["legality_rule_test"],
        unresolved_scope_rule_ids: [],
        derivation: "Derived from one exact rule.",
      },
    ],
    meta: {
      catalogue_revision_id: "catrev_test",
      published_at: "2026-08-01T00:00:00.000Z",
    },
    links: {
      self: "/v1/legality-status?card_id=card_test&on=2026-08-01&format=standard&region=EN-ASIA",
    },
  };
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  const emptyEventTier = structuredClone(base);
  emptyEventTier.data[0].event_tier = "";
  assert.equal(validate(emptyEventTier), false);
  const evidence = {
    ...base,
    included: [
      {
        type: "source_observation",
        id: "srcobs_test",
        captured_at: "2026-07-31T00:00:00.000Z",
        source: "gundam-en-asia",
      },
    ],
    provenance: {
      "/data/0/status": ["srcobs_test"],
      "/data/0/rule_ids/0": ["srcobs_test"],
      "/data/0/derivation": ["srcobs_test"],
    },
  };
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
});

test("Card browsing documents and validates collection, detail, and problem representations", async () => {
  const [openapi, schema] = await Promise.all([
    readFile(resolve(root, "prototype/formalize-implementation-contracts/openapi.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "prototype/formalize-implementation-contracts/schemas/api.schema.json"), "utf8").then(
      JSON.parse,
    ),
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
    "provenance must identify resources in included",
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

test("the Catalogue Export schema carries typed Product, Release, and Legality projections", async () => {
  const [api, exportSchema, exportManifest] = await Promise.all(
    ["api.schema.json", "catalogue-export-record-v5.schema.json", "catalogue-export-manifest-v5.schema.json"].map(
      async (name) =>
        JSON.parse(await readFile(resolve(root, "prototype/formalize-implementation-contracts/schemas", name), "utf8")),
    ),
  );
  assert.equal(api.$defs.Printing.required.includes("products"), false);
  assert.equal(api.$defs.Printing.required.includes("distribution_contexts"), true);
  assert.deepEqual(api.$defs.Product.properties.name.oneOf, [{ type: "string", minLength: 1 }, { type: "null" }]);
  assert.equal(api.$defs.Release.required.includes("event_key"), true);
  assert.equal(api.$defs.Release.required.includes("status"), true);
  assert.equal(api.$defs.PrintingProductProjection.properties.source_observation_ids.minItems, 1);
  assert.equal(api.$defs.DistributionContext.properties.source_observation_ids.minItems, 1);
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
    exportManifest.$defs.ReleasesComponent.allOf[1].properties.record_schema.const.includes(
      "catalogue-export-record@5",
    ),
  );
  for (const definition of ["PrintingProductProjection", "PrintingDistributionContextProjection"]) {
    assert.equal(exportSchema.$defs[definition].properties.source_observation_ids.minItems, 1);
  }
});

test("the baseline registers exactly the installed adapter versions immutably", async () => {
  const baseline = await readFile(resolve(root, "migrations", "0001_baseline.sql"), "utf8");
  // The seed rows must equal installedSourceAdapterRegistrations in
  // src/catalogue/source-adapters.ts. Before Go-Live (ADR 0008) each Source
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
    const versions = database
      .prepare(
        `SELECT adapter_version, source_lineage, supported_game,
              game_profile_version, parser_contract, adapter_origin,
              request_capacity
       FROM source_adapter_versions
       ORDER BY adapter_version`,
      )
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
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  };

  const fresh = new DatabaseSync(":memory:");
  fresh.exec(baseline);
  assertVersionSet(fresh);
  fresh.close();
});
