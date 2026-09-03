import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

const root = resolve(import.meta.dirname, "../..");

test("Official Errata evidence has an explicit normative contract", async () => {
  const schema = JSON.parse(
    await readFile(
      resolve(root, "docs/contracts/official-errata.schema.json"),
      "utf8",
    ),
  );
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
      resolve(
        root,
        "prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v5.schema.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    exportSchema.$defs.ErratumRecord.properties.corrected_value.type,
    ["string", "null"],
  );

  const contract = await readFile(
    resolve(root, "docs/contracts/official-errata.md"),
    "utf8",
  );
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
  assert.match(
    contract,
    /https:\/\/en\.onepiece-cardgame\.com\/rules\/errata_card\//,
  );
});

test("the baseline enforces the reconciliation workflow and Errata constraints", async () => {
  const baseline = await readFile(
    resolve(root, "migrations", "0001_baseline.sql"),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(baseline);
    database.exec(`
      INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, idempotency_key, candidate_digest,
        candidate_created_at, approval_deadline, candidate_json, approval_json
      ) VALUES (
        'run_schema', 'publishing', '["one-piece"]',
        '2026-07-31T00:00:00.000Z', 'catrev_spine_000', 'schema-run',
        '${"a".repeat(64)}', '2026-07-31T00:00:00.000Z',
        '2099-07-31T00:00:00.000Z', '{}',
        '{"candidate_digest":"${"a".repeat(64)}","expected_current_revision_id":"catrev_spine_000"}'
      );
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
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM revision_card_query_documents",
      ).get().count,
      0,
    );

    database.prepare(
      `INSERT INTO reconciliation_workflow_requests (
         idempotency_key, ingestion_run_id, expected_current_revision_id,
         request_json, workflow_params_json, workflow_instance_id, observed_at
       ) VALUES (?, ?, ?, '{}', '{}', ?, ?)`,
    ).run(
      "workflow-valid",
      "run_schema",
      "catrev_bootstrap_not_yet_published",
      "workflow-schema",
      "2026-07-31T00:02:00.000Z",
    );
    assert.throws(
      () =>
        database.prepare(
          `INSERT INTO reconciliation_workflow_requests (
             idempotency_key, ingestion_run_id, expected_current_revision_id,
             request_json, workflow_params_json, workflow_instance_id,
             observed_at
           ) VALUES (?, ?, ?, '{}', '{}', ?, ?)`,
        ).run(
          "workflow-missing-run",
          "run_missing",
          "catrev_spine_000",
          "workflow-missing-run",
          "2026-07-31T00:02:00.000Z",
        ),
      /FOREIGN KEY constraint failed/,
    );

    assert.throws(
      () =>
        database.prepare(
          `INSERT INTO reconciliation_terminal_results (
             ingestion_run_id, result_json
           ) VALUES (?, ?)`,
        ).run("run_schema", "not-json"),
      /CHECK constraint failed/,
    );
    database.prepare(
      `INSERT INTO reconciliation_terminal_results (
         ingestion_run_id, result_json
       ) VALUES (?, '{}')`,
    ).run("run_schema");
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
    const insertErratum = database.prepare(
      `INSERT INTO reconciled_errata (
         id, game, target_type, target_id, effective_from,
         official_wording, corrected_value_json, first_revision_id,
         last_observed_revision_id
       ) VALUES (?, ?, ?, ?, NULL, 'Official correction', ?,
                 'catrev_schema', 'catrev_schema')`,
    );
    assert.throws(
      () =>
        insertErratum.run(
          "erratum_card_wrong_game",
          "gundam",
          "card",
          "card_one_piece",
          '"Corrected"',
        ),
      /reconciled_erratum_target_invalid/,
    );
    assert.throws(
      () =>
        insertErratum.run(
          "erratum_printing_wrong_game",
          "gundam",
          "printing",
          "printing_one_piece",
          '"Corrected"',
        ),
      /reconciled_erratum_target_invalid/,
    );
    insertErratum.run(
      "erratum_card_valid",
      "one-piece",
      "card",
      "card_one_piece",
      '"Corrected"',
    );
    insertErratum.run(
      "erratum_printing_valid",
      "one-piece",
      "printing",
      "printing_one_piece",
      '"Corrected"',
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      database.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  } finally {
    database.close();
  }
});

test("the Card collection contract normatively exposes projection unavailability as 503", async () => {
  const [openapi, apiSchema] = await Promise.all([
    readFile(
      resolve(
        root,
        "prototype/formalize-implementation-contracts/openapi.json",
      ),
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
  assert.equal(
    openapi.paths["/cards"].get.responses["503"].$ref,
    "#/components/responses/CatalogueQueryUnavailable",
  );
  assert.equal(
    openapi.components.responses.CatalogueQueryUnavailable.content[
      "application/problem+json"
    ].schema.$ref,
    "./schemas/api.schema.json#/$defs/Problem",
  );
  assert.equal(
    apiSchema.$defs.Problem.properties.code.enum.includes(
      "catalogue_query_unavailable",
    ),
    true,
  );
});
