import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

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

test("Printing machine schema v1 keeps typed projections additive", async () => {
  const [api, exportSchema] = await Promise.all(
    [
      "api.schema.json",
      "catalogue-export-record.schema.json",
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
  assert.equal(api.$defs.Release.required.includes("status"), false);
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
  assert.equal(
    exportSchema.$defs.ReleaseRecord.required.includes("event_key"),
    false,
  );
  assert.equal(
    exportSchema.$defs.ReleaseRecord.required.includes("status"),
    false,
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

test("migration history is forward-only and registers the production adapter in 0006", async () => {
  const [migration3, migration6] = await Promise.all(
    ["0003_immutable_source_evidence.sql", "0006_product_release_distribution.sql"]
      .map((name) =>
        readFile(resolve(root, "migrations", name), "utf8")
      ),
  );
  assert.match(migration3, /'one-piece-json-document@2'/u);
  assert.doesNotMatch(migration3, /'one-piece-en@1'/u);
  assert.match(
    migration6,
    /INSERT INTO source_adapter_versions[\s\S]*'one-piece-en@1'/u,
  );
  assert.match(migration6, /'one-piece-json-document@2'/u);
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
         'one-piece-en@1'
       )
       ORDER BY adapter_version`,
    ).all().map(({ adapter_version, adapter_origin }) => ({
      adapter_version,
      adapter_origin,
    }));
    assert.deepEqual(versions, [
      {
        adapter_version: "one-piece-en@1",
        adapter_origin: "production",
      },
      {
        adapter_version: "one-piece-json-document@1",
        adapter_origin: "synthetic_fixture",
      },
      {
        adapter_version: "one-piece-json-document@2",
        adapter_origin: "synthetic_fixture",
      },
    ]);
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
