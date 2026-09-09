import assert from "node:assert/strict";

export function acceptedBackupRetry(result, idempotencyKey) {
  assert.ok([0, 10].includes(result.code), result.stdout + result.stderr);
  const document = JSON.parse(result.stdout);
  if (result.code === 10) {
    assert.equal(document.contract, "card-keepr-catalogue-backup-workflow@1");
    assert.equal(document.status, "running");
    assert.equal(document.idempotency_key, idempotencyKey);
    assert.equal(typeof document.workflow_instance_id, "string");
    assert.ok(document.workflow_instance_id.length > 0);
  }
  return document;
}

export async function resumeExistingBackupAttempt(existing, expected, send) {
  assert.equal(existing.idempotency_key, expected.idempotency_key);
  assert.equal(existing.linked_attempt_id, expected.failed_attempt_id);
  assert.equal(existing.catalogue_revision_id, expected.expected_current_revision_id);
  if (!existing.resume) {
    assert.ok(["verified", "failed"].includes(existing.state));
    return false;
  }
  assert.equal(existing.resume.method, "POST");
  assert.equal(existing.resume.path, "/v1/backups");
  assert.deepEqual(existing.resume.body, expected);
  const observed = await send(existing.resume);
  assert.equal(observed.contract, "card-keepr-catalogue-backup-workflow@1");
  assert.equal(observed.idempotency_key, existing.idempotency_key);
  assert.equal(observed.workflow_instance_id, existing.workflow_instance_id);
  return true;
}
