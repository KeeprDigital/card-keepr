# Owner administration contract

Contract: `card-keepr-administration@1`

The repository CLI is the only initial owner interface. It talks to the
ingestion Worker for catalogue operations, to GitHub for a production release
dispatch, and to the owning secret stores for credential operations. The
ingestion Worker never receives GitHub or Cloudflare deployment credentials.

## Interaction rules

Read-only commands never prompt. Every production-changing command:

- requires `--environment production`;
- prints the resolved Cloudflare account, Worker, D1, and R2 identities before
  confirmation;
- names every target by opaque identity;
- checks an expected current Catalogue Revision;
- accepts secrets only from an interactive hidden prompt, keychain reference,
  or stdin descriptor, never an argument; and
- returns stable JSON with `--json` and the exit codes below.

`--yes` is accepted only with `--confirm` equal to the complete resolved
production-target JSON where applicable, plus the expected revision, content
or backup digest, and an idempotency key. The production-target document binds
the Cloudflare account, both Worker scripts, both D1 databases, and every
private R2 bucket. Missing, partial, reordered, or altered confirmation fails
before mutation.

Exit codes are `0` success, `2` usage, `3` confirmation declined, `4`
authentication, `5` authorization, `6` not found, `7` conflict or stale
precondition, `8` contract validation, `9` remote/platform failure, and `10`
operation accepted but not yet terminal.

## Commands

| CLI command | Mutation | Required preconditions or bindings |
| --- | --- | --- |
| `keepr status` | no | none |
| `keepr run start` | yes | exact Supported Games; no active run; recovery not blocked |
| `keepr run show` | no | run identity |
| `keepr run reconcile` | yes | exact run identity; expected current Catalogue Revision; idempotency key; production confirmation after resolving the production run and its bound revision; starts or observes the bound reconciliation Workflow |
| `keepr candidate inspect` | no | run in `awaiting_approval` |
| `keepr run approve` | yes | run identity, candidate digest, expected current revision, unexpired candidate, verified current backup |
| `keepr run reject` | yes | run identity and candidate digest |
| `keepr run retry` | yes | terminal source run; creates a new linked run |
| `keepr backup status` | no | Catalogue Revision identity |
| `keepr backup create` | yes | expected current Catalogue Revision; idle ingestion; exact production target; idempotency key |
| `keepr backup retry` | yes | current revision; exact failed attempt and export/backup digest |
| `keepr catalogue-export deletion prepare` | no | exact Catalogue Revision, manifest digest, expected current revision |
| `keepr catalogue-export deletion confirm` | yes | unexpired plan and plan digest; exact Catalogue Revision, manifest digest, expected current revision, typed confirmation, idempotency key |
| `keepr catalogue-export deletion status` | no | deletion identity |
| `keepr catalogue-export deletion retry` | yes | failed deletion identity; unchanged target and object-set digest; idle mutation gates |
| `keepr recovery begin` | yes | target Catalogue Revision or bookmark; ingestion and release idle |
| `keepr recovery verify` | yes | recovery operation and restored target digest |
| `keepr recovery accept` | yes | verified recovery operation and expected restored revision |
| `keepr release production` | yes | manual dispatch; production target; expected current revision; ingestion idle; recovery healthy |
| `keepr credential rotate` | yes | credential class; replacement supplied out of band |
| `keepr credential verify` | yes | rotation identity and harmless class-specific probe |
| `keepr credential revoke-old` | yes | verified replacement and exact old credential fingerprint |
| `keepr catalogue search repair` | yes | exact target among the current Catalogue Revision and its two immediate predecessors; expected current Catalogue Revision; idempotency key; production confirmation after resolving production status; one bounded repair step |

The ingestion Workflow owns automatic collection, parsing, reconciliation,
candidate finalization, publication, export verification, expiry, and backup
attempt progression. The CLI observes these automatic transitions; it cannot
skip or rewrite them.

`run reconcile` never executes reconciliation inline in the HTTP request. Its
request is exactly `{expected_current_revision_id, idempotency_key}` and is
bound to the run identity in the route. An exact replay observes the same
Workflow instance; reuse of the idempotency key for another run or expected
revision fails closed.
The initial request returns HTTP `202` only when its Workflow is non-terminal;
an instance that completes during creation and every terminal replay returns
HTTP `200`. A queued, running, waiting, or paused document exits `10`; a
terminal document exits `0` regardless of whether the server returned it from
the initial POST or a replay. A paused exact instance is resumed. An errored or
terminated instance deterministically consumes any retained reconciliation
result. Missing or malformed completed-Workflow output also recovers the exact
retained candidate or immutable terminal result, while a valid output remains
binding-checked. The first exact no-candidate terminal failure result is
retained immutably before the global mutation lock is released, so a later loss
of Workflow output or error detail cannot alter replay. This also recovers a
Workflow whose failure-finalization step itself exhausted retries.

`catalogue search repair` performs one resumable, byte-bounded repair step. Its
request is exactly
`{target_revision_id, expected_current_revision_id, idempotency_key}`. The
target remains explicit even when it is the current Catalogue Revision and is
limited to that revision plus its two immediate predecessors. Every unfinished
replay atomically rechecks the retained expected-current guard before claiming
another step. An exact completed replay returns the persisted result; a stale
expected revision or conflicting idempotency request fails closed.
The CLI exits `10` while the repair result reports `complete: false` and exits
`0` only for a completed repair result.
Before retaining or claiming an unfinished request, every source
`revision_cards.document_json` is checked against a durable 65,536-byte UTF-8
bound. An oversized legacy Card fails with HTTP `422` before any search
materialization begins. Within that per-Card source bound, each repair step
completes up to 25 Cards. It advances through CAS-guarded D1 batches of at most
500 search entries plus one cursor statement, never binds more than 65,536
bytes to one statement, and stops after a 20-second cooperative invocation
budget. Progress within a Card is durable, so a complex Card resumes without
requiring one immutable administration request per search term.
The CLI resolves that repair window from the authoritative retained revision
chain in production status, never from the bounded recent-run diagnostic list.
Every advertised member joins to a real published Catalogue Revision; the
unpublished bootstrap spine is never a repair target. Reconciliation target
validation remains independent of this repair-only window.

## Catalogue Export deletion

Preparation resolves the manifest and every component to an exact immutable R2
object set and returns a plan:

```text
prepared --confirm exact bindings--> deleting → deleted
                                      deleting → failed → deleting
```

A plan expires after 15 minutes. It always warns that Catalogue Consumers may
depend on the immutable bytes and that known URLs will return
`catalogue_export_deleted`. The current Catalogue Revision is a blocking
dependency: its verified Catalogue Export cannot be deleted.

Confirmation atomically rechecks the plan digest, Catalogue Revision, manifest
digest, object-set digest, expected current Catalogue Revision, expiry,
availability, typed Catalogue Revision confirmation, idempotency key, idle
ingestion and release, and healthy recovery. The export disappears from listing
and serving when the operation enters `deleting`, so a partially removed package
is never presented as verified.

Deletion is confined to
`catalogue-exports/<catalogue_revision_id>/`; the manifest is removed last and
absence of every bound object is verified. Source and reconciliation evidence,
Catalogue Revision records, backups, Time Travel bookmarks, recovery exports,
and the deletion plan, operation, and tombstone remain retained. A failed
operation stays unavailable and can only retry the same object-set digest.

Stable result codes are:

- `catalogue_export_not_found`, `catalogue_export_not_available`;
- `manifest_digest_mismatch`, `current_revision_mismatch`;
- `unsafe_export_object_scope`, `deletion_plan_not_found`,
  `deletion_plan_expired`, `deletion_plan_mismatch`;
- `current_export_required`, `maintenance_not_idle`,
  `confirmation_required`, `catalogue_export_changed`;
- `idempotent_replay`, `idempotency_key_reused`;
- `export_deletion_not_found`, `export_deletion_not_active`,
  `export_deletion_not_failed`, `deleted_object_set_mismatch`; and
- `ok`.

## Ingestion Run states

The only legal non-terminal path is:

```text
planning → collecting → parsing → reconciling → awaiting_approval
          → publishing → published
```

`planning`, `collecting`, `parsing`, and `reconciling` may become `failed`.
`awaiting_approval` may become `publishing`, `rejected`, `expired`, or `failed`.
`publishing` may become `published` or `failed`. `published`, `rejected`,
`expired`, and `failed` are immutable terminal states.

Entering `awaiting_approval` fixes the candidate digest and a deadline exactly
seven 24-hour periods after `candidate_created_at`. At or after the deadline,
expiry wins over concurrent approval. Approval atomically rechecks run state,
deadline, candidate digest, expected current revision, active-run identity, and
recovery health.

## Backup and recovery states

`backup create` starts or observes one idempotently bound ingestion Workflow
for the D1 export/restore verification boundary. The durable Workflow
temporarily removes only the derived Card FTS structures, exports and retains
the SQL backup, reconstructs live search in a `finally` path, restores into the
configured disposable D1, reconstructs search there, and verifies the expected
Catalogue Revision before recovery becomes healthy. Active phases are
owner-bound and resumable, so a retried Workflow continues the retained export,
restore, or verification phase rather than creating another attempt.
The first non-terminal response is HTTP `202`; exact replays observe the same
Workflow instance, resume a paused instance, and return HTTP `200`. The CLI
exits `10` until the Workflow is complete. A retained terminal success or
failure is an HTTP `200` observation and exits `0`.

`backup create` durably binds its exact expected revision to the idempotency
key before export and creates an immutable backup attempt:

```text
pending → exporting → restoring_verification → verifying → verified
```

Any active backup state may become `failed`. A retry creates another immutable
attempt with a new idempotency key. Exact replays return the retained verified
document or retained failure without repeating export or restore; changed reuse
fails closed. The SQL artifact streams from D1 into private R2 and from R2 into
the disposable D1 without whole-artifact Worker buffering. Only a `verified`
attempt whose restored database passes SQLite integrity, derived-index, and
representative Card API projection checks for the current Catalogue Revision
makes recovery `healthy`.

A recovery operation follows:

```text
preparing → restoring → validating → awaiting_acceptance → accepted
```

Any non-terminal state may become `failed`. Beginning recovery sets recovery
health to `blocked` and blocks ingestion and releases. Failure remains blocked;
the owner must resume with a new linked operation or explicitly restore and
verify another target. Acceptance makes recovery healthy and records the
restored current Catalogue Revision.

`recovery begin` binds a production target, recovery identity, method, exact
Catalogue Revision and D1 bookmark, verified backup manifest digest and attempt,
expected current revision, optional failed-operation link, and idempotency key.
It records the current bookmark where the platform exposes one. Time Travel
retains the restore response's `previous_bookmark` as the immediate undo
reference. Replacement recovery imports into a new D1 database and retains the
old database identity through acceptance; changing bindings is a separately
reviewed deployment action. `recovery verify` reuses every backup verification
check against the exact restored database and digest. `recovery accept` requires
the expected restored revision, target digest, typed recovery identity,
production binding observation, idempotency key, and exact production
confirmation. Changed idempotent replays fail closed; exact replays return the
retained operation without repeating a restore, verification, or acceptance.

## Release and credential states

A production release follows:

```text
requested → preflight → migrating → deploying → smoke_testing → succeeded
```

Any non-terminal state may become `failed`. One release may be active. The
workflow rechecks the expected Catalogue Revision, idle ingestion, healthy
recovery, bindings, migration level, and recovery bookmark before mutation.
After a migration, failure is corrected by a compatible roll-forward unless a
schema-compatible Worker rollback is proven.

A credential rotation follows:

```text
replacement_installed → replacement_verified → old_revoked
```

The old credential remains usable until verification succeeds. The API traffic
gate may deliberately overlap both values during consumer cutover. The
administration key uses a harmless authenticated status probe. Cloudflare
operation tokens and the GitHub-held deployment token use class-specific
least-privilege probes in their owning boundary.

`administration.mjs` is the executable reference transition table. Any
production implementation must accept every transition it accepts, reject
every transition it rejects with the same stable code, and preserve the same
terminal-state and concurrency invariants.
