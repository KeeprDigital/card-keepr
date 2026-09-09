import assert from "node:assert/strict";
import test from "node:test";
import { acceptedBackupRetry, resumeExistingBackupAttempt } from "./helpers/native-backup-retry.mjs";

test("backup retry accepts only the exact running workflow for CLI exit 10", () => {
  const document = {
    contract: "card-keepr-catalogue-backup-workflow@1",
    idempotency_key: "retry",
    status: "running",
    workflow_instance_id: "workflow",
  };
  const result = (value, code = 10) => ({ code, stdout: JSON.stringify(value), stderr: "" });
  assert.deepEqual(acceptedBackupRetry(result(document), "retry"), document);
  for (const patch of [
    { contract: "unrelated" },
    { status: "failed" },
    { idempotency_key: "other" },
    { workflow_instance_id: "" },
  ])
    assert.throws(() => acceptedBackupRetry(result({ ...document, ...patch }), "retry"));
  assert.throws(() => acceptedBackupRetry(result(document, 8), "retry"));
});

test("restarted exporting backup resumes the same Workflow once; terminal success and mismatches do not submit", async () => {
  const expected = {
    expected_current_revision_id: "revision",
    idempotency_key: "retry",
    failed_attempt_id: "failed",
    failed_attempt_digest: "digest",
  };
  const existing = {
    state: "exporting",
    idempotency_key: "retry",
    linked_attempt_id: "failed",
    catalogue_revision_id: "revision",
    workflow_instance_id: "workflow",
    resume: { method: "POST", path: "/v1/backups", body: expected },
  };
  let sent = 0;
  const send = async () => {
    sent++;
    return {
      contract: "card-keepr-catalogue-backup-workflow@1",
      idempotency_key: "retry",
      workflow_instance_id: "workflow",
    };
  };
  assert.equal(await resumeExistingBackupAttempt(existing, expected, send), true);
  assert.equal(sent, 1);
  assert.equal(
    await resumeExistingBackupAttempt({ ...existing, state: "verified", resume: null }, expected, send),
    false,
  );
  for (const patch of [{ method: "GET" }, { path: "/different" }, { body: { ...expected, idempotency_key: "new" } }])
    await assert.rejects(
      resumeExistingBackupAttempt({ ...existing, resume: { ...existing.resume, ...patch } }, expected, send),
    );
  assert.equal(sent, 1);
  await assert.rejects(
    resumeExistingBackupAttempt(existing, expected, async () => ({
      contract: "card-keepr-catalogue-backup-workflow@1",
      idempotency_key: "retry",
      workflow_instance_id: "different",
    })),
  );
});
