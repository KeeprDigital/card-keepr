import * as publishedCatalogueQueries from "./query-helpers/published-catalogue.ts";
import * as reconciliationQueries from "./query-helpers/reconciliation.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

const root = resolve(import.meta.dirname, "../..");

test("Official Errata evidence has an explicit normative contract", async () => {
  const schema = JSON.parse(await readFile(resolve(root, "docs/contracts/official-errata.schema.json"), "utf8"));
  assert.deepEqual(schema.required, [
    "authority",
    "field",
    "target_type",
    "effective_from",
    "official_wording",
    "corrected_value",
  ]);
  assert.deepEqual(schema.properties.authority.enum, ["official_errata"]);
  assert.deepEqual(schema.properties.field.enum, ["effective_rules_text"]);
  assert.deepEqual(schema.properties.target_type.enum, ["card", "printing"]);
  assert.deepEqual(schema.properties.corrected_value.type, ["string", "null"]);
  const exportSchema = JSON.parse(
    await readFile(
      resolve(root, "prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v5.schema.json"),
      "utf8",
    ),
  );
  assert.deepEqual(exportSchema.$defs.ErratumRecord.properties.corrected_value.type, ["string", "null"]);

  const contract = await readFile(resolve(root, "docs/contracts/official-errata.md"), "utf8");
  for (const term of [
    "Official Source",
    "Card",
    "Printing",
    "Effective Rules Text",
    "Printed Rules Text",
    "effective_from",
    "official_wording",
    "corrected_value",
  ]) {
    assert.match(contract, new RegExp(term));
  }
  assert.match(contract, /https:\/\/en\.onepiece-cardgame\.com\/rules\/errata_card\//);
});

test("the baseline enforces the reconciliation workflow and Errata constraints", async () => {
  const baseline = await readFile(resolve(root, "migrations", "0001_baseline.sql"), "utf8");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(baseline);
    database.exec(`
      INSERT INTO ingestion_runs (
        id, started_at, expected_current_revision_id, idempotency_key
      ) VALUES ('run_schema', '2026-07-31T00:00:00.000Z', 'catrev_spine_000', 'schema-run');
      UPDATE operation_state
      SET active_ingestion_run_id = 'run_schema'
      WHERE singleton = 1;
      INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (
        'catrev_schema', 'run_schema', '2026-07-31T00:01:00.000Z',
        '${"b".repeat(64)}', 'catrev_spine_000', '${"a".repeat(64)}'
      );
      INSERT INTO revision_cards (
        catalogue_revision_id, card_id, document_json
      ) VALUES (
        'catrev_schema', 'card_historical', '{"id":"card_historical"}'
      );
    `);
    // Card query documents are built by the resumable application repair,
    // never by a trigger on revision_cards.
    assert.equal(publishedCatalogueQueries.countRevisionCardQueryDocumentsCount(database).get().count, 0);

    reconciliationQueries
      .insertReconciliationWorkflowRequests(database)
      .run(
        "workflow-valid",
        "run_schema",
        "catrev_bootstrap_not_yet_published",
        "workflow-schema",
        "2026-07-31T00:02:00.000Z",
      );
    assert.throws(
      () =>
        reconciliationQueries
          .insertReconciliationWorkflowRequests(database)
          .run(
            "workflow-missing-run",
            "run_missing",
            "catrev_spine_000",
            "workflow-missing-run",
            "2026-07-31T00:02:00.000Z",
          ),
      /FOREIGN KEY constraint failed/,
    );

    assert.throws(
      () => reconciliationQueries.insertReconciliationTerminalResults(database).run("run_schema", "not-json"),
      /CHECK constraint failed/,
    );
    reconciliationQueries
      .insertReconciliationTerminalResultsForBaselineEnforcesReconciliationWorkflowErrataConstraints(database)
      .run("run_schema");
    assert.throws(
      () =>
        database.exec(
          `UPDATE reconciliation_terminal_results
           SET result_json = '{"changed":true}'
           WHERE ingestion_run_id = 'run_schema'`,
        ),
      /reconciliation_terminal_result_immutable/,
    );
    assert.throws(
      () =>
        database.exec(
          `DELETE FROM reconciliation_terminal_results
           WHERE ingestion_run_id = 'run_schema'`,
        ),
      /reconciliation_terminal_result_immutable/,
    );

    database.exec(`
      INSERT INTO reconciled_cards (
        id, supported_game, official_identity_kind,
        official_identity_value, first_revision_id,
        last_observed_revision_id
      ) VALUES
        ('card_one_piece', 'one-piece', 'card_number', 'OP01-001',
         'catrev_schema', 'catrev_schema');
      INSERT INTO reconciled_printings (
        id, card_id, source_lineage, artwork_fingerprint,
        printed_fields_digest, rarity_normalized, treatment,
        first_revision_id, last_observed_revision_id
      ) VALUES (
        'printing_one_piece', 'card_one_piece', 'one-piece-en',
        'artwork', '${"c".repeat(64)}', 'leader', NULL,
        'catrev_schema', 'catrev_schema'
      );
    `);
    const insertErratum = reconciliationQueries.insertReconciledErrata(database);
    // Cross-game target authority belongs to the publication repository after
    // #106. SQLite retains structural vocabulary and immutable Erratum facts.
    assert.throws(
      () => insertErratum.run("erratum_invalid_target", "one-piece", "product", "card_one_piece", '\"Corrected\"'),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insertErratum.run("erratum_invalid_value", "one-piece", "card", "card_one_piece", "{}"),
      /CHECK constraint failed/,
    );
    insertErratum.run("erratum_card_valid", "one-piece", "card", "card_one_piece", '"Corrected"');
    insertErratum.run("erratum_printing_valid", "one-piece", "printing", "printing_one_piece", '"Corrected"');
    assert.throws(() => database.exec("UPDATE reconciled_errata SET game = 'gundam'"), /reconciled_erratum_immutable/);
    assert.throws(() => database.exec("DELETE FROM reconciled_errata"), /reconciled_erratum_immutable/);
    assert.deepEqual(publishedCatalogueQueries.inspectForeignKeyCheck(database).all(), []);
    assert.equal(publishedCatalogueQueries.inspectIntegrityCheck(database).get().integrity_check, "ok");
  } finally {
    database.close();
  }
});

test("the Card collection contract normatively exposes projection unavailability as 503", async () => {
  const [openapi, apiSchema] = await Promise.all([
    readFile(resolve(root, "prototype/formalize-implementation-contracts/openapi.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "prototype/formalize-implementation-contracts/schemas/api.schema.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  assert.equal(openapi.paths["/cards"].get.responses["503"].$ref, "#/components/responses/CatalogueQueryUnavailable");
  assert.equal(
    openapi.components.responses.CatalogueQueryUnavailable.content["application/problem+json"].schema.$ref,
    "./schemas/api.schema.json#/$defs/Problem",
  );
  assert.equal(apiSchema.$defs.Problem.properties.code.enum.includes("catalogue_query_unavailable"), true);
});
