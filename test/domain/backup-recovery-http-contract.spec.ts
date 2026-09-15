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

test("generated backup requests retain nonopaque keys and require the complete retry evidence pair", () => {
  const validate = request("/v1/backups");
  const input = { expected_current_revision_id: "catrev_current", idempotency_key: "backup / " + "x".repeat(240) };
  expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
  const retry = { ...input, failed_attempt_id: "failed / " + "x".repeat(240), failed_attempt_digest: "a".repeat(64) };
  expect(validate(retry), JSON.stringify(validate.errors)).toBe(true);
  for (const change of [
    { idempotency_key: "" },
    { idempotency_key: ["key"] },
    { failed_attempt_id: "failed" },
    { failed_attempt_digest: "a".repeat(64) },
    { failed_attempt_id: null, failed_attempt_digest: null },
    { unexpected: true },
  ])
    expect(validate({ ...input, ...change }), JSON.stringify(change)).toBe(false);
  expect(validate({ ...retry, failed_attempt_digest: "A".repeat(64) })).toBe(false);
});

test("generated recovery inputs require explicit owner and backup bindings without nullable defaults", () => {
  const validate = request("/v1/recoveries");
  const input = {
    environment: "production",
    recovery_id: "recovery",
    method: "replacement_database",
    target_revision_id: "catrev_retained",
    target_bookmark: "bookmark",
    target_digest: "b".repeat(64),
    backup_attempt_id: "backup",
    expected_current_revision_id: "catrev_current",
    idempotency_key: "begin",
  };
  expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ ...input, method: "time_travel", linked_operation_id: "failed-recovery" })).toBe(true);
  for (const change of [
    { method: "restore" },
    { recovery_id: "recovery / malformed" },
    { linked_operation_id: null },
    { target_digest: "b".repeat(63) },
    { target_bookmark: "" },
    { environment: null },
    { unexpected: true },
  ])
    expect(validate({ ...input, ...change }), JSON.stringify(change)).toBe(false);
  const { backup_attempt_id: _backup, ...missing } = input;
  expect(validate(missing)).toBe(false);
  const verify = request("/v1/recoveries/{recovery}/verification");
  expect(verify({ target_digest: input.target_digest, idempotency_key: "verify" })).toBe(true);
  expect(verify({ target_digest: input.target_digest })).toBe(false);
  const accept = request("/v1/recoveries/{recovery}/acceptance");
  const acceptance = {
    expected_restored_revision_id: input.target_revision_id,
    target_digest: input.target_digest,
    confirmation_recovery_id: input.recovery_id,
    idempotency_key: "accept",
  };
  expect(accept(acceptance)).toBe(true);
  expect(accept({ ...acceptance, confirmation_recovery_id: null })).toBe(false);
  expect(accept({ ...acceptance, bound_database_id: "client-selected" })).toBe(false);
});

test("generated Workflow status separates in-progress, dispatch failure and both completed outcomes", () => {
  const validate = ajv.compile({ $ref: "administration#/components/schemas/CatalogueBackupWorkflow" });
  const pending = ajv.compile({ $ref: "administration#/components/schemas/PendingCatalogueBackupWorkflow" });
  const identity = {
    contract: "card-keepr-catalogue-backup-workflow@1",
    expected_current_revision_id: "catrev",
    idempotency_key: "key",
    workflow_instance_id: "workflow",
  };
  const running = { ...identity, status: "running", output: null };
  expect(validate(running)).toBe(true);
  expect(pending(running)).toBe(true);
  const failure = {
    ...identity,
    status: "complete",
    output: {
      contract: "card-keepr-catalogue-backup-workflow-failure@1",
      code: "backup_failed",
      detail: "Restore failed.",
    },
  };
  expect(validate(failure), JSON.stringify(validate.errors)).toBe(true);
  expect(pending(failure)).toBe(false);
  expect(validate({ ...failure, output: null })).toBe(false);
  expect(validate({ ...running, status: "dispatch_failed" })).toBe(false);
  expect(validate({ ...running, output: failure.output })).toBe(false);
});

test("generated target resolution requires the full backup or recovery intent", () => {
  const validate = request("/v1/administration-targets/resolve");
  const backup = { expected_current_revision_id: "catrev", idempotency_key: "backup / " + "x".repeat(240) };
  expect(validate({ backup })).toBe(true);
  expect(validate({ backup: { ...backup, failed_attempt_id: "parent", failed_attempt_digest: "a".repeat(64) } })).toBe(
    true,
  );
  expect(validate({ backup: { ...backup, failed_attempt_id: "parent" } })).toBe(false);
  const recovery = {
    action: "verify",
    recovery_id: "recovery",
    input: { target_digest: "a".repeat(64), idempotency_key: "verify" },
  };
  expect(validate({ recovery })).toBe(true);
  expect(validate({ recovery: { ...recovery, input: { target_digest: "a".repeat(64) } } })).toBe(false);
  expect(validate({ recovery: { ...recovery, unexpected: true } })).toBe(false);
  expect(validate({ backup, recovery })).toBe(false);
  expect(validate({ backup: [] })).toBe(false);
});
