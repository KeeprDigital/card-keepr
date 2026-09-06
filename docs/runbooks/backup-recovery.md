# Catalogue backup and recovery

A Backup Attempt exports a Catalogue Revision to private R2, restores it into a
Disposable Restore database, and verifies the restored catalogue before marking
the attempt `verified`. Disposable Restore is proof that the backup can be read;
it does not change the production binding. Catalogue Recovery restores production
and keeps mutation blocked until verification and explicit owner acceptance.

## Inspect after publication

Use the ingestion administration endpoint and its existing credential setup
(`KEEPR_INGESTION_URL` and `KEEPR_ADMINISTRATION_KEY`). Run these commands from the
repository root. The examples use `jq` and shell variables; replace operation
identities with unique values for the operation you intend to perform.

```sh
npm run --silent keepr -- status --json > status.json
CURRENT_REVISION=$(jq -er '.safe_state.current_revision_id' status.json)
npm run --silent keepr -- backup status \
  --catalogue-revision "$CURRENT_REVISION" --json > backups.json
```

Inspect the published run's backup reference and the revision's `attempts`.
Publication and backup completion are separate observations: an accepted Workflow
dispatch is not restore proof. A successful attempt has `state: verified`, retained
SQL and manifest digests, and a Disposable Restore identity/generation. Check
`release_preflight` in a fresh status document for the verified current backup,
bookmark, manifest digest, and retained-revision evidence. Current plus two
predecessors must have verified export and recovery evidence for an ordinary
Production Release; Bootstrap Mode applies only before the first publication.

Keep the successful backup output or status snapshot with the operation record.
For the current revision, the following values name one exact verified target:

```sh
npm run --silent keepr -- status --json > verified-status.json
TARGET_REVISION=$(jq -er '.safe_state.current_revision_id' verified-status.json)
TARGET_BACKUP_ATTEMPT=$(jq -er '.release_preflight.recovery_backup_attempt_id' verified-status.json)
TARGET_BOOKMARK=$(jq -er '.release_preflight.recovery_bookmark' verified-status.json)
TARGET_DIGEST=$(jq -er '.release_preflight.recovery_manifest_digest' verified-status.json)
npm run --silent keepr -- backup status \
  --attempt-id "$TARGET_BACKUP_ATTEMPT" --json > verified-attempt.json
jq -e --arg revision "$TARGET_REVISION" --arg digest "$TARGET_DIGEST" \
  '.state == "verified" and .catalogue_revision_id == $revision and .manifest_sha256 == $digest' \
  verified-attempt.json
```

For an earlier retained revision, use its recorded successful backup output or
verified status snapshot. The target digest is the **manifest SHA-256**; the SQL
content digest and the status document's attempt digest serve different purposes.
The target bookmark is required for both recovery methods. Recovery also requires
the backup's schema level to match the current catalogue schema.

## Create, resume, or retry a Backup Attempt

Every mutation command requires an exact confirmation envelope. First run the
chosen command with `--environment production --yes` and without `--confirm`;
it prints the required confirmation and exits `3` without applying that mutation.
Review the resolved target and copy the complete confirmation JSON, unchanged,
into `EXACT_CONFIRMATION`. Rerun that same command with
`--confirm "$EXACT_CONFIRMATION"`. Obtain a fresh confirmation for each distinct
operation below; a changed current revision requires a fresh inspection.

With ingestion idle and recovery healthy, create a backup of the current revision:

```sh
BACKUP_ATTEMPT=backup-2026-09-04-01
npm run --silent keepr -- backup create \
  --expected-current-revision "$CURRENT_REVISION" \
  --idempotency-key "$BACKUP_ATTEMPT" \
  --environment production --yes --confirm "$EXACT_CONFIRMATION" --json
npm run --silent keepr -- backup status --attempt-id "$BACKUP_ATTEMPT" --json
```

Inspect `dispatch`, `workflow_instance_id`, `state`, `restore_phase`, and `failure`.
While pending or active, replay the original create/retry command with the same
arguments and idempotency key to resume dispatch or observe its retained outcome.
Do not create a new identity to bypass an active attempt. The same key with a
different request is rejected. After an ambiguous SQL import, the workflow starts
a new Restore Generation on a clean disposable target; it does not import a second
time into a possibly populated target.

A failed attempt is immutable. Only the latest failed leaf may be retried, using
its exact ID and current attempt digest, with a new idempotency key:

```sh
npm run --silent keepr -- backup status \
  --attempt-id "$BACKUP_ATTEMPT" --json > failed-attempt.json
jq -e '.state == "failed"' failed-attempt.json
FAILED_ATTEMPT=$(jq -er '.idempotency_key' failed-attempt.json)
FAILED_DIGEST=$(jq -er '.attempt_digest' failed-attempt.json)
RETRY_ATTEMPT=backup-2026-09-04-02
npm run --silent keepr -- backup retry \
  --expected-current-revision "$CURRENT_REVISION" \
  --failed-attempt-id "$FAILED_ATTEMPT" --failed-attempt-digest "$FAILED_DIGEST" \
  --idempotency-key "$RETRY_ATTEMPT" \
  --environment production --yes --confirm "$EXACT_CONFIRMATION" --json
```

Inspect the retry by its new attempt ID. Resolve stale-revision, digest, or
superseded-attempt conflicts from fresh status; do not modify retained evidence.
A failed backup does not become verified merely because an R2 SQL object exists.

## Begin Catalogue Recovery

Retain the target values above independently of the live database. Refresh
`CURRENT_REVISION` from status immediately before starting recovery. Ingestion and
Production Release must be idle. Choose one method:

| Method | Restore action | Evidence retained |
| --- | --- | --- |
| `time_travel` | Restore the bound production D1 to the exact backup bookmark | Original database identity, restored bookmark, and provider-returned undo bookmark |
| `replacement_database` | Import the retained SQL into a replacement D1 | Original/retained database and replacement database identities |

```sh
npm run --silent keepr -- status --json > current-status.json
CURRENT_REVISION=$(jq -er '.safe_state.current_revision_id' current-status.json)
RECOVERY_ID=recovery-2026-09-04-01
RECOVERY_METHOD=time_travel
npm run --silent keepr -- recovery begin \
  --recovery-id "$RECOVERY_ID" --method "$RECOVERY_METHOD" \
  --target-revision "$TARGET_REVISION" --target-bookmark "$TARGET_BOOKMARK" \
  --target-digest "$TARGET_DIGEST" --backup-attempt-id "$TARGET_BACKUP_ATTEMPT" \
  --expected-current-revision "$CURRENT_REVISION" \
  --idempotency-key "$RECOVERY_ID-begin" \
  --environment production --yes --confirm "$EXACT_CONFIRMATION" --json
npm run --silent keepr -- recovery inspect --recovery-id "$RECOVERY_ID" --json
```

Set `RECOVERY_METHOD=replacement_database` to use the replacement path. Begin
acquires the recovery block before restoring and persists an R2 recovery journal
so Time Travel can reconstruct the operation even when D1 rolls back its own
control rows. Successful restore reaches `validating`; mutation remains blocked.
A timeout is not proof of failure: inspect the same operation and replay the exact
request if necessary before deciding on a follow-up.

## Verify, bind, and accept

Run verification for either method with a fresh confirmation:

```sh
npm run --silent keepr -- recovery verify \
  --recovery-id "$RECOVERY_ID" --target-digest "$TARGET_DIGEST" \
  --idempotency-key "$RECOVERY_ID-verify" \
  --environment production --yes --confirm "$EXACT_CONFIRMATION" --json
npm run --silent keepr -- recovery inspect \
  --recovery-id "$RECOVERY_ID" --json > recovery.json
jq -e '.state == "awaiting_acceptance" and .verification != null' recovery.json
```

Verification reconstructs derived data and checks the exact revision, schema,
counts, and representative catalogue and Curated Revision evidence
against the backup manifest. Inspect the retained verification document and
failure details; an import finishing successfully is insufficient.

For **replacement database** recovery, follow the
[replacement-D1 handoff](production-release.md#replacement-d1-handoff) before
acceptance. Supply the recovery ID, verified replacement ID, and retained original
ID from `recovery.json` to the guarded Production Release. That release binds both
Workers to the replacement and records the observed binding. Keep the original
database. A partial handoff stays blocked and requires a compatible roll-forward.

For **Time Travel**, the restored database already has the production binding.
Retain the undo bookmark for incident analysis or a separately planned recovery;
there is no automatic rollback when verification fails.

The owner accepts only after reviewing verification and, for replacement recovery,
the successful handoff evidence:

```sh
npm run --silent keepr -- recovery accept \
  --recovery-id "$RECOVERY_ID" --confirmation-recovery-id "$RECOVERY_ID" \
  --expected-restored-revision "$TARGET_REVISION" --target-digest "$TARGET_DIGEST" \
  --idempotency-key "$RECOVERY_ID-accept" \
  --environment production --yes --confirm "$EXACT_CONFIRMATION" --json
npm run --silent keepr -- recovery inspect --recovery-id "$RECOVERY_ID" --json
npm run --silent keepr -- status --json
npm run --silent keepr -- health --json
```

Require `state: accepted`, the intended current revision, `recovery_health: healthy`,
and `active_recovery_id: null`; both runtimes must be healthy. Acceptance verifies
the live bound database and retained evidence before clearing the mutation block.
An acceptance replay rechecks evidence before releasing a still-blocked operation.

## Failure and follow-up

Failed restore or verification leaves recovery blocked. Keep the operation ID,
manifest/SQL digests, bookmarks, database IDs, verification output, and any release
run/version IDs. Inspect the retained failure, correct the cause, then begin a
new recovery with a new ID and key plus `--linked-operation-id "$RECOVERY_ID"`,
using freshly inspected current state and exact verified backup evidence. A linked
follow-up requires the previous operation to be failed or accepted. Do not clear
recovery flags with SQL or erase the old database to make a gate pass.

Production Release failures after migration require compatible roll-forward as
specified in the [release runbook](production-release.md). Schema-changing
pre-Go-Live work may instead require deliberate data regeneration under ADR 0008;
that is a separate owner decision, not recovery acceptance.
