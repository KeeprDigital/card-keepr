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
});
