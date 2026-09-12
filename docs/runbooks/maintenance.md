# Maintenance

Use the configured owner CLI (`pnpm run keepr`, shown as `keepr`). For commands
with production-target confirmation, first omit `--confirm`, inspect the exact
resolved JSON, then repeat unchanged with that confirmation. A new operation or
changed target requires fresh confirmation. See the
[administration contract](../../contracts/ADMINISTRATION.md).

## Health and unexpected failures

`keepr health --json` checks authenticated readiness on both Workers. `/health`
verifies database/schema, object bindings, ingestion Workflows, public base and
version; a failed check returns 503 with a safe reason code. `/healthz` is an
unauthenticated minimal liveness response and does not prove binding readiness.
Use each Worker's mount when configuring external monitors.

For an `internal_error`, find its `request_id` in protected Worker logs.
`request.completed` records route/runtime/status and database-call counts;
`request.failed` (`card-keepr-protected-failure@1`) records up to four classified
causes and stack fingerprints. Fingerprints group failures within the same build;
they cannot reconstruct a stack and may change with a release. Reproduce against
the exact deployed revision. Expected 404s and domain problems keep their normal
HTTP contract. Raw provider messages, SQL, credentials and bodies belong in neither
consumer responses nor protected diagnostic payloads.

## Repair search after a projection migration

Inspect `keepr status --json` for the authoritative current-plus-two retained
revision chain; recent run diagnostics are not that chain. For each eligible
revision, repeat bounded repair steps until `complete: true`:

```sh
keepr catalogue search repair --target-revision TARGET_REVISION \
  --expected-current-revision CURRENT_REVISION --idempotency-key STEP_INTENT \
  --environment production --confirm "$EXACT_CONFIRMATION" --yes --json
```

Use a new key for each new bounded step. Replaying a key observes that step.
Bootstrap spine and archived revisions outside the retained chain cannot be
repaired. Oversized retained legacy Card JSON fails before repair is recorded;
new publication writes its search facts and availability atomically. A repair
step is bounded and resumable, not a whole-catalogue rebuild.

## Reclaim unused terminal evidence

Cleanup selects one terminal collection or failed/abandoned preparation. The
default wait is 30 days after its terminal clock; `--retention-days` pins a
positive whole-day policy for that immutable intent. Backup retention and export
deletion have separate policies.

```sh
keepr evidence-cleanup start --run-id RUN --idempotency-key CLEANUP_INTENT --json
keepr staging-cleanup start --preparation-id PREPARATION --idempotency-key STAGING_INTENT --json
keepr evidence-cleanup status --cleanup-id CLEANUP --json
keepr evidence-cleanup objects --cleanup-id CLEANUP --json
keepr evidence-cleanup retry --cleanup-id CLEANUP --expected-generation GENERATION --json
```

Choose the applicable start command. Workflow shards advance bounded physical-key
inventories; they never infer ownership from bucket listings. Object pages contain
at most 50 entries; pass the last `object_key` as `--after`. Retry keeps the intent
and recorded results while advancing dispatch generation.

References from candidates, cross-run revalidation, mappings, decisions,
publication or recovery protect physical bytes. Logical reservation prevents new
use (`410 evidence_reclaimed`) while audit identities remain. Physical deletion
waits for older retained backups that could restore an unfenced identity; cleanup
never shortens backup retention to force progress. A later verified checkpoint
includes cleanup reservations and preserves the unavailable state on recovery.

`paused` and per-key results distinguish backup-retention waits, unsettled
writers/deleters and retryable storage failures. A timeout, absent HEAD or another
successful deletion does not settle an ambiguous write/delete ticket. Do not
clear tickets manually. Reuse requires every delete ticket for that exact key
incarnation to settle. Recovery admission likewise waits for unresolved storage
writers; an older snapshot cannot erase a call that might still finish.

## Delete an old export package

Use `catalogue-export deletion prepare` then `catalogue-export deletion confirm` with the
expiring plan and confirmation described in the
[export deletion contract](../../contracts/ADMINISTRATION.md#catalogue-export-deletion).
The current export is protected. Confirmation makes an eligible package unavailable
before its exclusive manifest is removed; shared components and backup/reference
closure remain protected. Known deleted URLs return 410; unknown identities
remain 404. Keep the tombstone, digests and retained recovery evidence.
