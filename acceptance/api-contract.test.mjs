import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");

test("historical export schemas remain byte-identical to their fixed points", async () => {
  for (const [name, digest, id] of [
    ["catalogue-export-manifest-v1.schema.json", "72741f3e6d20a6cf28ecb6db4292e1d5e95c8727ca91c009cf48988289486537", "catalogue-export-manifest@1"],
    ["catalogue-export-record-v1.schema.json", "37683203c58b62f56afebd25477fe48b3ec188c108201fea56bb635f0f9660ea", "catalogue-export-record@1"],
    ["catalogue-export-manifest-v2.schema.json", "17fc18d953c9f1bcef660788c1c29914d618fb616515c627358c4dd9455fc545", "catalogue-export-manifest@2"],
    ["catalogue-export-record-v2.schema.json", "904f97add01325f2d1b4e038b80be095b522a7db7ef21574e12062a1ceee3d73", "catalogue-export-record@2"],
  ]) {
    const bytes = await readFile(resolve(
      root,
      `prototype/formalize-implementation-contracts/schemas/${name}`,
    ));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    assert.equal(JSON.parse(bytes.toString("utf8")).$id.endsWith(id), true);
  }
});

test("Product detail documents invalid include requests", async () => {
  const openapi = JSON.parse(
    await readFile(
      resolve(
        root,
        "prototype/formalize-implementation-contracts/openapi.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    openapi.paths["/products/{product_id}"].get.responses["400"],
    { $ref: "#/components/responses/InvalidRequest" },
  );
});

test("Legality Status documents and validates base and evidence representations", async () => {
  const [openapi, schema] = await Promise.all([
    readFile(
      resolve(root, "prototype/formalize-implementation-contracts/openapi.json"),
      "utf8",
    ).then(JSON.parse),
    readFile(
      resolve(
        root,
        "prototype/formalize-implementation-contracts/schemas/api.schema.json",
      ),
      "utf8",
    ).then(JSON.parse),
  ]);
  const include = openapi.paths["/legality-status"].get.parameters.find(
    (parameter) => parameter.name === "include",
  );
  assert.deepEqual(include?.schema, { type: "string", enum: ["evidence"] });

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(
    `${schema.$id}#/$defs/LegalityStatusDocument`,
  );
  const base = {
    data: [{
      card_id: "card_test",
      on: "2026-08-01",
      format: "standard",
      event_tier: null,
      region: "EN-ASIA",
      status: "not_legal",
      rule_ids: ["legality_rule_test"],
      derivation: "Derived from one exact rule.",
    }],
    meta: {
      catalogue_revision_id: "catrev_test",
      published_at: "2026-08-01T00:00:00.000Z",
    },
    links: {
      self:
        "/v1/legality-status?card_id=card_test&on=2026-08-01&format=standard&region=EN-ASIA",
    },
  };
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  const evidence = {
    ...base,
    included: [{
      type: "source_observation",
      id: "srcobs_test",
      captured_at: "2026-07-31T00:00:00.000Z",
      source: "gundam-en-asia",
    }],
    provenance: {
      "/data/0/status": ["srcobs_test"],
      "/data/0/rule_ids/0": ["srcobs_test"],
      "/data/0/derivation": ["srcobs_test"],
    },
  };
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
});

test("export schema major 3 carries typed Product, Release, and Legality projections", async () => {
  const [api, exportSchema, exportManifest] = await Promise.all(
    [
      "api.schema.json",
      "catalogue-export-record.schema.json",
      "catalogue-export-manifest.schema.json",
    ].map(async (name) =>
      JSON.parse(
        await readFile(
          resolve(
            root,
            "prototype/formalize-implementation-contracts/schemas",
            name,
          ),
          "utf8",
        ),
      )
    ),
  );
  assert.equal(api.$defs.Printing.required.includes("products"), false);
  assert.equal(
    api.$defs.Printing.required.includes("distribution_contexts"),
    true,
  );
  assert.deepEqual(api.$defs.Product.properties.name.oneOf, [
    { type: "string", minLength: 1 },
    { type: "null" },
  ]);
  assert.equal(api.$defs.Release.required.includes("event_key"), true);
  assert.equal(api.$defs.Release.required.includes("status"), true);
  assert.equal(
    api.$defs.PrintingProductProjection.properties
      .source_observation_ids.minItems,
    1,
  );
  assert.equal(
    api.$defs.DistributionContext.properties
      .source_observation_ids.minItems,
    1,
  );
  assert.equal(
    exportSchema.$defs.PrintingRecord.required.includes("products"),
    false,
  );
  assert.equal(
    exportSchema.$defs.PrintingRecord.required.includes(
      "distribution_contexts",
    ),
    false,
  );
  assert.equal(
    exportSchema.$defs.ProductRecord.properties.name.$ref,
    "#/$defs/NullableText",
  );
  assert.equal(
    exportSchema.$defs.SupportedGameRecord.properties.name.minLength,
    1,
  );
  assert.equal(exportSchema.$id.endsWith("catalogue-export-record@3"), true);
  assert.equal(exportManifest.$id.endsWith("catalogue-export-manifest@3"), true);
  assert.equal(exportManifest.properties.export_schema_major.const, 3);
  assert.equal(
    exportSchema.$defs.ReleaseRecord.required.includes("event_key"),
    true,
  );
  assert.equal(
    exportSchema.$defs.ReleaseRecord.required.includes("status"),
    true,
  );
  assert.ok(
    exportManifest.$defs.ReleasesComponent.allOf[1].properties.record_schema
      .const.includes("catalogue-export-record@3"),
  );
  for (const definition of [
    "PrintingProductProjection",
    "PrintingDistributionContextProjection",
  ]) {
    assert.equal(
      exportSchema.$defs[definition].properties
        .source_observation_ids.minItems,
      1,
    );
  }
});

test("migration 0006 upgrades an applied 0001-0005 database and also applies fresh", async () => {
  const migrations = await Promise.all(
    [
      "0001_catalogue_publication.sql",
      "0002_ingestion_lifecycle.sql",
      "0003_immutable_source_evidence.sql",
      "0004_card_printing_reconciliation.sql",
      "0005_credential_rotation.sql",
      "0006_product_release_distribution.sql",
    ].map((name) => readFile(resolve(root, "migrations", name), "utf8")),
  );
  const assertVersionSet = (database) => {
    const versions = database.prepare(
      `SELECT adapter_version, adapter_origin
       FROM source_adapter_versions
       WHERE adapter_version IN (
         'one-piece-json-document@1',
         'one-piece-json-document@2',
         'one-piece-en@1',
         'fusion-world-en@1',
         'fusion-world-en@2',
         'digimon-en@1',
         'digimon-en@2',
         'gundam-en-asia@1',
         'gundam-en-asia@2',
         'gundam-en-us@1',
         'gundam-en-us@2'
       )
       ORDER BY adapter_version`,
    ).all().map(({ adapter_version, adapter_origin }) => ({
      adapter_version,
      adapter_origin,
    }));
    assert.deepEqual(versions, [
      {
        adapter_version: "digimon-en@1",
        adapter_origin: "production",
      },
      {
        adapter_version: "digimon-en@2",
        adapter_origin: "production",
      },
      {
        adapter_version: "fusion-world-en@1",
        adapter_origin: "production",
      },
      {
        adapter_version: "fusion-world-en@2",
        adapter_origin: "production",
      },
      {
        adapter_version: "gundam-en-asia@1",
        adapter_origin: "production",
      },
      {
        adapter_version: "gundam-en-asia@2",
        adapter_origin: "production",
      },
      {
        adapter_version: "gundam-en-us@1",
        adapter_origin: "production",
      },
      {
        adapter_version: "gundam-en-us@2",
        adapter_origin: "production",
      },
      {
        adapter_version: "one-piece-en@1",
        adapter_origin: "production",
      },
      {
        adapter_version: "one-piece-json-document@1",
        adapter_origin: "production",
      },
      {
        adapter_version: "one-piece-json-document@2",
        adapter_origin: "production",
      },
    ]);
    assert.throws(
      () =>
        database.exec(
          `UPDATE source_adapter_versions
           SET parser_contract = 'mutated'
           WHERE adapter_version = 'one-piece-en@1'`,
        ),
      /source_adapter_version_immutable/u,
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      database.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  };

  const upgraded = new DatabaseSync(":memory:");
  migrations.slice(0, 5).forEach((migration) => upgraded.exec(migration));
  assert.equal(
    upgraded.prepare(
      `SELECT count(*) AS count
       FROM source_adapter_versions
       WHERE adapter_version = 'one-piece-json-document@2'`,
    ).get().count,
    1,
  );
  upgraded.exec(migrations[5]);
  assertVersionSet(upgraded);
  upgraded.close();

  const fresh = new DatabaseSync(":memory:");
  migrations.forEach((migration) => fresh.exec(migration));
  assertVersionSet(fresh);
  fresh.close();
});
