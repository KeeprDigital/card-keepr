import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test } from "vitest";

const document = JSON.parse(readFileSync("contracts/admin-openapi.json", "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true, inlineRefs: false });
addFormats(ajv);
ajv.addSchema(document, "administration");
function request(path: string) {
  return ajv.compile({
    $ref: `administration#/paths/${path.replaceAll("/", "~1")}/post/requestBody/content/application~1json/schema`,
  });
}

test("staging generated requests preserve singleton replay shape while rejecting changed types and extra fields", () => {
  const validate = request("/v1/staging-releases");
  const command = {
    release_id: "stage",
    idempotency_key: "a".repeat(256),
    expected_head_sha: "a".repeat(40),
    expected_actor: "owner",
    ci_run_id: "123",
    validation_scope: "full",
    prepare: true,
  };
  for (const validation_scope of ["auto", "full", ["full"], [["full"]]])
    expect(validate({ ...command, validation_scope }), JSON.stringify(validate.errors)).toBe(true);
  for (const change of [
    { validation_scope: [] },
    { validation_scope: ["full", "full"] },
    { validation_scope: [["full", "full"]] },
    { validation_scope: null },
    { ci_run_id: 123 },
    { unexpected: true },
    { prepare: "true" },
    { idempotency_key: "a".repeat(257) },
  ])
    expect(validate({ ...command, ...change }), JSON.stringify(change)).toBe(false);
});

test("generated release target arrays enforce their actual lengths", () => {
  const validate = ajv.compile({ $ref: "administration#/components/schemas/ReleaseEnvironmentTarget" });
  const target = {
    cloudflare_account_id: "account",
    worker_scripts: ["api", "ingestion"],
    d1_databases: [
      { name: "catalogue", id: "one" },
      { name: "disposable", id: "two" },
    ],
    r2_buckets: ["evidence", "images", "exports", "backups"],
  };
  expect(validate(target), JSON.stringify(validate.errors)).toBe(true);
  for (const worker_scripts of [[], ["api"], ["api", "ingestion", "unexpected"]])
    expect(validate({ ...target, worker_scripts })).toBe(false);
  for (const d1_databases of [[], target.d1_databases.slice(0, 1), [...target.d1_databases, target.d1_databases[0]]])
    expect(validate({ ...target, d1_databases })).toBe(false);
});

test("export deletion generated requests retain unconstrained owner identities and exact confirmation fields", () => {
  const validate = request("/v1/catalogue-export-deletions");
  const command = {
    plan_id: "plan " + "x".repeat(240),
    plan_digest: "a".repeat(64),
    catalogue_revision_id: "catrev_old",
    manifest_digest: "b".repeat(64),
    expected_current_revision_id: "catrev_current",
    confirmation_revision_id: "catrev_old",
    deletion_id: "delete " + "x".repeat(240),
    idempotency_key: "owner request / with spaces",
  };
  expect(validate(command), JSON.stringify(validate.errors)).toBe(true);
  for (const change of [
    { plan_digest: "invalid" },
    { confirmation_revision_id: "" },
    { idempotency_key: 1 },
    { extra: true },
  ])
    expect(validate({ ...command, ...change })).toBe(false);
  const { confirmation_revision_id: _confirmation, ...missing } = command;
  expect(validate(missing)).toBe(false);
});

test("production release generated commands require typed owner choices and keep optional historical handoff separate", () => {
  const validate = request("/v1/production-releases");
  const command = {
    release_id: "release",
    idempotency_key: "release-key",
    expected_current_revision_id: "catrev_spine_000",
    expected_head_sha: "a".repeat(40),
    expected_actor: "github-actions[bot]",
    expected_migration_level: 37,
    bootstrap: true,
    replacement_handoff: null,
    prepare: true,
  };
  expect(validate(command), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ ...command, fresh_baseline_handoff: null }), JSON.stringify(validate.errors)).toBe(true);
  for (const change of [
    { expected_migration_level: "37" },
    { bootstrap: "true" },
    { expected_actor: "owner" },
    { fresh_baseline_handoff: { destination_database_id: "database", baseline_sha256: "b".repeat(64) } },
    { production_target: {} },
  ])
    expect(validate({ ...command, ...change })).toBe(false);
});

test("target resolution uses typed choices and search repair requires exact identifiers", () => {
  const validate = request("/v1/administration-targets/resolve");
  expect(validate({ expected_current_revision_id: "catrev_current" }), JSON.stringify(validate.errors)).toBe(true);
  expect(
    validate({ expected_current_revision_id: "catrev_current", repair_revision_id: "catrev_old" }),
    JSON.stringify(validate.errors),
  ).toBe(true);
  expect(
    validate({ recovery_id: "recovery", target_digest: "a".repeat(64), expected_restored_revision_id: "catrev_old" }),
    JSON.stringify(validate.errors),
  ).toBe(false);
  expect(validate({ recovery_id: "recovery" })).toBe(false);
  expect(validate({ expected_current_revision_id: "catrev_current", arbitrary: true })).toBe(false);
  const repair = request("/v1/catalogue-search-materialization/repair");
  const command = {
    target_revision_id: "catrev_old",
    expected_current_revision_id: "catrev_current",
    idempotency_key: "repair_key",
  };
  expect(repair(command), JSON.stringify(repair.errors)).toBe(true);
  expect(repair({ ...command, target_revision_id: [] })).toBe(false);
  expect(repair({ ...command, idempotency_key: "x".repeat(201) })).toBe(false);
  expect(repair({ ...command, idempotency_key: "owner key" })).toBe(false);
});

test("target resolution documents retained Curated relationship extensions without widening fresh validation", () => {
  const validate = request("/v1/administration-targets/resolve");
  const target = {
    kind: "relationship",
    relationship_kind: "product-card",
    from: { type: "product", id: "product", "": "retained endpoint", later: [1, null] },
    to: { type: "card", id: "card", "": { reviewed: true } },
    "": "retained target",
    later: { exact: true },
  };
  Object.defineProperty(target, "__proto__", { value: ["literal extension"], enumerable: true });
  const command = {
    expected_current_revision_id: "catrev_current",
    curated_operation: "create",
    curated_binding: {
      affected_supported_game: "one-piece",
      target,
      content_digest: "a".repeat(64),
      idempotency_key: "retained",
    },
  };
  expect(validate(command), JSON.stringify(validate.errors)).toBe(true);
  expect(
    validate({
      ...command,
      curated_operation: "supersede",
      curated_binding: {
        curated_revision_id: "currev_old",
        expected_event_version: 1,
        conflict_digest: null,
        idempotency_key: "retained-replacement",
        replacement_supported_game: "one-piece",
        replacement_target: target,
        replacement_content_digest: "b".repeat(64),
      },
    }),
    JSON.stringify(validate.errors),
  ).toBe(true);
  expect(
    validate({
      ...command,
      curated_binding: {
        ...command.curated_binding,
        target: { ...target, from: { ...target.from, type: "invented" } },
      },
    }),
  ).toBe(false);
  const freshTarget = ajv.compile({
    $ref: "administration#/components/schemas/CuratedRevisionProposal/properties/target",
  });
  expect(freshTarget(target)).toBe(false);
});
