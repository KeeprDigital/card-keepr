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

test("export schema major 2 carries typed Product and Release projections", async () => {
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
  assert.equal(exportSchema.$id.endsWith("catalogue-export-record@2"), true);
  assert.equal(exportManifest.$id.endsWith("catalogue-export-manifest@2"), true);
  assert.equal(exportManifest.properties.export_schema_major.const, 2);
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
      .const.includes("catalogue-export-record@2"),
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
  assert.doesNotMatch(migration6, /UPDATE source_adapter_versions/iu);
  assert.match(migration6, /'fusion-world-en@2'/u);
  assert.match(migration6, /source_adapter_version_is_immutable/u);
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

test("dynamic request ordering is transactional and ancestry does not depend on a hash sort key", async () => {
  const [repository, reconciliation] = await Promise.all([
    readFile(
      resolve(root, "src/catalogue/source-evidence-repository.ts"),
      "utf8",
    ),
    readFile(
      resolve(root, "src/catalogue/reconciliation-evidence.ts"),
      "utf8",
    ),
  ]);
  assert.match(
    repository,
    /COALESCE\s*\(\s*MAX\(sequence_number\)\s*,\s*-1\s*\)\s*\+\s*1/iu,
  );
  assert.doesNotMatch(
    repository,
    /Number\.parseInt\(digest\.slice\(0,\s*12\),\s*16\)/u,
  );
  assert.doesNotMatch(
    reconciliation,
    /parent\.sequence_number\s*>=\s*request\.sequence_number/u,
  );
});

test("the parent Workflow owns the collection barrier and automatic reconciliation", async () => {
  const workflow = await readFile(
    resolve(root, "apps/ingestion/src/evidence-workflows.ts"),
    "utf8",
  );
  const parent = workflow.slice(
    workflow.indexOf("export class EvidenceIngestionWorkflow"),
    workflow.indexOf("export class EvidenceHostWorkflow"),
  );
  const host = workflow.slice(
    workflow.indexOf("export class EvidenceHostWorkflow"),
  );
  const barrier = parent.slice(
    parent.indexOf("let barrierStage = 0"),
    parent.indexOf("if (run.state === \"parsing\""),
  );
  assert.match(parent, /finalizeEvidenceRun/u);
  assert.match(parent, /reconcileRetainedCardPrintingEvidence/u);
  assert.match(barrier, /pendingEvidenceRequests\(\s*this\.env\.CATALOGUE_DB,\s*runId/u);
  assert.match(barrier, /child\.restart\(\)/u);
  assert.match(barrier, /child\.resume\(\)/u);
  assert.match(parent, /run\.plan_origin === "production"/u);
  assert.match(parent, /state === "collecting"/u);
  assert.doesNotMatch(host, /finalizeEvidenceRun/u);
});
