import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

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
        "prototype/formalize-implementation-contracts/schemas/catalogue-export-record.schema.json",
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

test("the 0007 schema migration is additive and leaves historical Card backfill to the resumable application repair", async () => {
  const migration = await readFile(
    resolve(root, "migrations/0007_errata_rules_text.sql"),
    "utf8",
  );
  assert.doesNotMatch(
    migration,
    /ALTER\s+TABLE\s+revision_cards\s+RENAME/iu,
  );
  assert.doesNotMatch(
    migration,
    /INSERT\s+INTO\s+revision_cards[\s\S]*FROM\s+revision_cards/iu,
  );
  const workflowRequests =
    /CREATE TABLE reconciliation_workflow_requests \(([\s\S]*?)\n\);/u
      .exec(migration)?.[1] ?? "";
  assert.match(
    workflowRequests,
    /ingestion_run_id[\s\S]*REFERENCES ingestion_runs\(id\)/u,
  );
  assert.doesNotMatch(
    workflowRequests,
    /expected_current_revision_id[\s\S]*REFERENCES catalogue_revisions\(id\)/u,
    "the bootstrap Catalogue state identity is valid before the first Catalogue Revision row exists",
  );
  const terminalResults =
    /CREATE TABLE reconciliation_terminal_results \(([\s\S]*?)\n\);/u
      .exec(migration)?.[1] ?? "";
  assert.match(
    terminalResults,
    /ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs\(id\)/u,
  );
  assert.match(terminalResults, /result_json TEXT NOT NULL/u);
  assert.match(terminalResults, /json_valid\(result_json\)/u);
  assert.match(
    migration,
    /CREATE TRIGGER reconciliation_terminal_results_are_immutable/u,
  );
  assert.match(
    migration,
    /CREATE TRIGGER reconciliation_terminal_results_are_not_deleted/u,
  );
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
