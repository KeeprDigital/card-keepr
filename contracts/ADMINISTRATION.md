# Owner administration contract

The maintained native protocol follows [per-game publication](../docs/architecture.md#per-game-publication-and-recovery).
An Ingestion Run records collection provenance; a Catalogue Candidate, its
Reconciliation Operation, artifact preparation and Publication Operation have
separate identities and progress. Publication approves one exact whole game
candidate against its Game Catalogue Revision predecessor.

The root of [administration.schema.json](schemas/administration.schema.json)
decodes historical `card-keepr-administration@1` snapshots. Its run-owned state
and approval definitions are retained for historical decoding, not current
status or native approval. The named `CommandRequest` definitions describe the
remaining unmigrated commands. Migrated HTTP inputs and responses come from the
[generated administration specification](admin-openapi.json), as described by the
[HTTP boundary](HTTP.md). Generation and sequence are non-negative safe integers;
each protocol below specifies its wire representation. Candidate control,
publication approval and publication resume send JSON integer generations.
Artifact preparation sends JSON integer generation and sequence.

The repository CLI is the only initial owner interface. It talks to the
ingestion Worker for catalogue operations, to GitHub for a production release
dispatch. The dev deployment endpoint receives a short-lived GitHub token only
for read-only exact-commit checks; no Worker receives Cloudflare deployment
credentials. See [isolated dev](../docs/runbooks/isolated-dev.md) for its signed
workflow authentication and release guards.

## Interaction rules

Read-only commands never prompt. Native commands use the configured ingestion
URL and administration key. `game-candidate prepare`, `pause`, `resume` and `abandon` require
`--yes`; native artifact preparation and publication commands bind the explicit
candidate or operation without a production-target confirmation option.

Pass `--target dev`, `--target staging` or `--target production` to select a
canonical remote profile. It uses only `KEEPR_<TARGET>_API_KEY` and
`KEEPR_<TARGET>_ADMINISTRATION_KEY`, with canonical environment URLs; unscoped
credentials and URL overrides are not inherited. Curated Revision commands
retain their separate stdin-secret interface. Omitting `--target` preserves
the existing configured URLs and unscoped credentials.

The production-target confirmation protocol used by `release production`,
recovery and maintenance has these requirements:

- require `--environment` to match the selected target, defaulting to `production`;
- print the resolved Cloudflare account, Worker, D1, and R2 identities before
  confirmation;
- name every target by opaque identity;
- check the operation-specific expected Catalogue Revision;
- accept secrets only from an interactive hidden prompt, keychain reference,
  or stdin descriptor, never an argument; and
- return stable JSON with `--json` and the exit codes below.

`--yes` is accepted only with `--confirm` equal to the complete resolved
production-target JSON where applicable, plus the expected revision, content
or backup digest, and an idempotency key. The production-target document binds
the Cloudflare account, both Worker scripts, both D1 databases, and every
private R2 bucket. Missing, partial, reordered, or altered confirmation fails
before mutation.

`release production` requires the production target. `release staging` also uses
`--target production`, because production records the owner intent and actual
starting target/schema. It dispatches only the server-issued staging workflow
inputs after one exact confirmation. Required options are `--release-id`,
`--expected-head-sha`, `--ci-run-id`, `--validation-scope`, `--idempotency-key`
and `--yes`; the confirmation binds the server-selected scope and required checks.
It returns exit `10` for dispatch acknowledgement. The signed workflow protocol,
first installation and separate immutable outcomes are defined in the
[manual staging procedure](../docs/runbooks/manual-staging.md).

`release staging-status --release-id <id> --target production` reads the retained
intent and workflow claim from `GET /v1/staging-releases/:release`; the staging
profile reads preparation/outcome from `GET /v1/staging-deployments/:release`.
Both require the respective environment's administration key and return exit `0`
for a retrieved document, including a failed outcome. `POST /v1/staging-releases`
is an owner-authenticated production route. The production authorization and
staging preparation/outcome POST routes accept the exact signed workflow identity,
never an administration key. Selecting a profile alone does not provision resources.

Exit codes are `0` success, `2` usage, `3` confirmation declined, `4`
authentication, `5` authorization, `6` not found, `7` conflict or stale
precondition, `8` contract validation or terminal publication failure, `9`
remote/platform failure, and `10` operation accepted but not yet terminal where
the command's presentation defines that pending outcome. Publication approval
exits `10` for its immutable acceptance; publication status exits `10` while
pending or paused, `8` on failure and `0` when published. Published still requires
separate Backup Attempt verification. Candidate preparation/control receipts exit
`10`; candidate status exits `10` while preparing or paused, `8` on failure, and
`0` for sealed, published or abandoned state. Read-only candidate inspection exits
`0` when its document is returned successfully. Artifact-preparation acceptance
exits `10`; its status exits `10` while pending/paused, `8` when failed and `0`
when verified. Callers must read `state` and `failure_code` and poll status;
neither exit `0` nor HTTP `202` proves publication or backup completion.

## Commands

| CLI command                               | Mutation | Required preconditions or bindings                                                                                                                                                                                             |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `keepr status`                            | no       | none                                                                                                                                                                                                                           |
| `keepr source collect`                    | yes      | exact source plan; source collection reservations; recovery not blocked                                                                                                                                                        |
| `keepr run show`                          | no       | run identity                                                                                                                                                                                                                   |
| `keepr run reconcile`                     | yes      | exact run identity; expected current Catalogue Revision; idempotency key; production confirmation after resolving the production run and its bound revision; starts or observes the bound reconciliation Workflow              |
| `keepr candidate inspect`                 | no       | retained historical run candidate; not native approval input                                                                                                                                                                   |
| `keepr run approve`                       | no       | retired locally with `run_approval_retired`, exit `2`, no request                                                                                                                                                              |
| `keepr run reject`                        | yes      | run identity and candidate digest                                                                                                                                                                                              |
| `keepr run retry`                         | yes      | terminal source run; creates a new linked run                                                                                                                                                                                  |
| `keepr backup status`                     | no       | Catalogue Revision identity                                                                                                                                                                                                    |
| `keepr backup create`                     | yes      | expected current Catalogue Revision; idle ingestion; exact production target; idempotency key                                                                                                                                  |
| `keepr backup retry`                      | yes      | current revision; exact failed attempt and export/backup digest                                                                                                                                                                |
| `keepr catalogue-export deletion prepare` | no       | exact Catalogue Revision, manifest digest, expected current revision                                                                                                                                                           |
| `keepr catalogue-export deletion confirm` | yes      | unexpired plan and plan digest; exact Catalogue Revision, manifest digest, expected current revision, typed confirmation, idempotency key                                                                                      |
| `keepr catalogue-export deletion status`  | no       | deletion identity                                                                                                                                                                                                              |
| `keepr catalogue-export deletion retry`   | yes      | failed deletion identity; unchanged target and object-set digest; idle mutation gates                                                                                                                                          |
| `keepr recovery begin`                    | yes      | target Catalogue Revision or bookmark; ingestion and release idle                                                                                                                                                              |
| `keepr recovery verify`                   | yes      | recovery operation and restored target digest                                                                                                                                                                                  |
| `keepr recovery accept`                   | yes      | verified recovery operation and expected restored revision                                                                                                                                                                     |
| `keepr release production`                | yes      | manual dispatch; production target; expected current revision; ingestion idle; recovery healthy                                                                                                                                |
| `keepr catalogue search repair`           | yes      | exact target among the current Catalogue Revision and its two immediate predecessors; expected current Catalogue Revision; idempotency key; production confirmation after resolving production status; one bounded repair step |

Collection Workflows retain evidence. Independent game preparation seals the
candidate and inspection artifacts; artifact and publication Workflows prepare
immutable consumer data, publish atomically and dispatch the exact backup.
These transitions preserve the original candidate deadline.

## Native candidate and publication commands

| CLI command                                         | HTTP route                                                                       | Exact inputs                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `keepr game-candidate prepare --yes`                | POST `/v1/game-candidates`                                                       | `ingestion_run_id`, `supported_game`, `expected_game_revision_id`, `idempotency_key`            |
| `keepr game-candidate list`                         | GET `/v1/ingestion-runs/:run/game-candidates`                                    | run ID; optional `after`                                                                        |
| `keepr game-candidate show`                         | GET `/v1/game-candidates/:candidate`                                             | candidate ID                                                                                    |
| `keepr game-candidate inspect`                      | GET `/v1/game-candidates/:candidate/inspection`                                  | candidate ID; optional `manifest` pin                                                           |
| `keepr game-candidate partitions`, `partition`      | GET `/v1/game-candidates/:candidate/partitions[/:ordinal]`                       | candidate ID; optional `manifest`; listing accepts `after`                                      |
| `keepr game-candidate evidence`                     | GET `/v1/game-candidates/:candidate/inspection/evidence/:kind`                   | candidate ID, evidence kind; optional `manifest`, `after`                                       |
| `keepr game-candidate pause --yes`                  | POST `/v1/game-candidates/:candidate/pause`                                      | candidate ID; JSON integer `generation`, `idempotency_key`                                      |
| `keepr game-candidate resume --yes`                 | POST `/v1/game-candidates/:candidate/resume`                                     | candidate ID; JSON integer `generation`, `idempotency_key`                                      |
| `keepr game-candidate abandon --yes`                | POST `/v1/game-candidates/:candidate/abandon`                                    | candidate ID; `generation`, `idempotency_key`                                                   |
| `keepr publication-preparation start`, `resume`     | POST `/v1/game-candidates/:candidate/publication-preparation/start` or `/resume` | candidate ID; `manifest_digest`, `generation`, `sequence`, `idempotency_key`                    |
| `keepr publication-preparation status`, `artifacts` | GET `/v1/game-candidates/:candidate/publication-preparation[/artifacts]`         | candidate ID; artifacts listing accepts `after`                                                 |
| `keepr publication approve`                         | POST `/v1/publications/start`                                                    | `candidate_id`, `manifest_digest`, `expected_game_revision_id`, `generation`, `idempotency_key` |
| `keepr publication status`                          | GET `/v1/publications/:operation`                                                | operation ID                                                                                    |
| `keepr publication resume`                          | POST `/v1/publications/:operation/resume`                                        | operation ID; operation `generation`, `idempotency_key`                                         |

CLI options use hyphens, with `--run-id` for `ingestion_run_id`, `--game` for
`supported_game`, and `--operation-id` for a Publication Operation. Candidate
control commands convert the decimal `--generation` option to a JSON integer.
Read current status for the generation before a new control intent. Run-level
`reconciliation pause/resume` targets the separate retained run preparation.

Candidate prepare, pause, resume and abandon return HTTP `202` with an immutable
`card-keepr-game-preparation-acceptance@1` receipt. It records the accepted action,
candidate/preparation/collection identities, predecessor, original deadline,
idempotency key and command generation. Its absolute `links.status` is also sent
as `Location`, with `Retry-After: 2` and `Cache-Control: no-store`. Exact replay
returns the same receipt even after the candidate progresses; its generation is
the accepted command's generation. GET candidate status returns HTTP `200` with
the current generation, state and outcome, also with `Cache-Control: no-store`.
Pause/resume never renews the original seven-day deadline. A changed key reuse
returns `409 idempotency_conflict`. A game slot, exact predecessor and
retained game evidence govern admission. Other games may collect, prepare and
receive approval concurrently; there is no global active-run prerequisite for
native approval. Recovery and the SQL snapshot fence still block mutations.

Fact, change and evidence pages require a sealed manifest. Their cursors bind that
manifest and the candidate's exact predecessor; advancing the current game head
changes readiness without rewriting retained pages. Progress and retained inputs
remain inspectable before sealing. Inspection readiness reports `ready`, `reason` and
`approval_scope: whole_candidate`. Follow every partition/evidence cursor and
restore referenced large text before reviewing; see the
[inspection runbook](../docs/runbooks/publication.md#prepare-and-inspect). A ready
candidate and verified publication artifacts are separate prerequisites. Intake
admission and candidate sealing never substitute for whole-candidate approval.

Partition responses identify `card_model` and `predecessor_card_model` from the
recorded preparation definitions. Aggregate predecessors without a preparation
definition use `unversioned`; their before-values can have either complete retained
record shape. `categories` requires the current Card category,
gameplay applicability and related-Card fields; `pre_categories` describes retained
facts from before that definition. A null predecessor model means the Spine
Revision. Historical before-values and old candidate facts retain their original
shape and bytes, while current candidate facts and after-values remain strict.
Normalized input partitions similarly identify their recorded `card_model`.
Retained identity and admission evidence can contain historical observations or
decisions. These representations do not authorize publishing an old candidate.

Partition listings return at most 100 entries. Metadata partitions contain at
most 500 records and 512 KiB. Each partition returns parallel `records` and
`text_parts` arrays. Reconstruct the ordered envelopes
`{contract: "card-keepr-partitioned-record@1", value: records[i], text_parts: text_parts[i]}`
and hash their canonical JSON using the [serialization rules](SERIALIZATION.md).
Text descriptors name a path, complete SHA-256, UTF-8 byte length and chunk count;
the path's null is a transport placeholder. Read
`GET /v1/game-candidates/:candidate/text/:digest/:ordinal`, concatenate `content`
in ordinal order and verify the full length/digest before restoring the path.
Raw text chunks are at most 128 KiB. Retained run inspection also exposes
`keepr reconciliation text --run-id RUN --digest SHA256 --ordinal ORDINAL`.
For inspection before/after values, resolve the referenced preparation's text.

Candidate image content uses
`GET /v1/game-candidates/:candidate/partitions/:ordinal/images/:record?manifest=SHA256`.
`record` is the zero-based index in a `printing_images` partition; an inspection
image instead selects `side=before` or `side=after`. The route verifies retained
bytes and refuses missing or corrupt content.

Artifact preparation starts at sequence `0`. Start and resume return HTTP `202`
with `card-keepr-publication-preparation-acceptance@1`, the original action's
candidate, manifest, sequence, generation, deadline and checkpoint, plus an
absolute `links.status`, `Location`, `Retry-After: 2` and `Cache-Control: no-store`.
Status returns the current artifact state, sequence, generation and root digest.
Use the status sequence on resume. Exact start/resume and unit intent replays
retain their original result even after completion; different reuse fails. The `/resume`
route sets `resume: true`. The unsuffixed POST route advances one bounded unit
and returns `200`; it accepts the same fields and optional boolean `resume`.
All generation and sequence fields are canonical JSON integers. Invalid typed
commands return `422`; malformed JSON returns `400`, wrong media `415` and bodies
over 16 KiB `413`. Invalid query parameters return `400`.

The artifact list returns at most 32 ordinal references with exact digests,
lengths and numeric `reused` flags. Prepared queries accept `kind`, `after` and
Card-only `q`, returning at most 32 private projection records and 512 KiB of
record JSON. POST `/v1/publication-compositions` takes one to five distinct
`candidate_ids`, at most one per game; its verified references remain private.

Approval returns HTTP `202` only after retaining an immutable acknowledgement
with contract `card-keepr-publication-acceptance@1`, `approval_scope: whole_candidate`,
`id`, `candidate_id`, manifest, predecessor, `candidate_generation`, operation
`generation`, deadline and `state: approved`. Exact replay returns that original
acknowledgement even after publication. It does not return the latest status.
The `/start` receipt includes an absolute `links.status`, also sent as `Location`,
and `Retry-After: 2`. Its request requires a JSON integer `generation` (the CLI
converts its decimal option once). GET status returns HTTP `200` with contract
`card-keepr-game-publication@1`, current state, `failure_code`,
`resulting_revision_id` and `backup_attempt_id`. POST `/v1/publications` retains
the same approval without dispatch, using `card-keepr-game-publication@1`; the owner CLI uses `/start` to dispatch.

Publication progresses through `approved`, `waiting_artifacts` or
`waiting_backup` to `published`, or ends in `failed`/pauses in `retry_paused`.
The switch rechecks the exact whole-candidate approval, manifest, game
predecessor, generation, original seven-day deadline and recovery fences. It
atomically advances the game and composition, records the result and reserves
its backup. Other games' approvals survive an unrelated-game publication. The
next switch waits for the exact current composition's verified backup. Equal
consumer facts preserve the revision and immutable exports while advancing the
private evidence head and requiring a new exact verified backup.

Resume uses the current **operation** generation and a new key; it preserves
candidate bindings and deadline, increments the writer generation, and returns
HTTP `202` with `card-keepr-publication-acceptance@1`, `Location`, `Retry-After`
and an absolute status link. Exact replay returns its retained acknowledgement and re-dispatches
remaining work. Always read status after an acknowledgement. A `published`
status identifies the backup attempt; observe `/v1/backups/:attempt` until
`verified` or `failed` when checkpoint completion is required.

Stable native errors include:

- `422 invalid_parameter`, `unsupported_game`, `invalid_generation`,
  `invalid_publication_approval`, `invalid_publication_preparation_intent`;
- `404 game_evidence_not_found`, `game_candidate_not_found`, `publication_not_found`;
- `409 idempotency_conflict`, `game_revision_mismatch`,
  `game_candidate_slot_occupied`, `candidate_pin_mismatch`, `candidate_not_ready`,
  `publication_approval_conflict`, `publication_resume_conflict`,
  `publication_ownership_conflict`, `recovery_not_verified`.

A returned status may instead retain a failure such as
`publication_deadline_expired`, `publication_candidate_conflict` or
`publication_legacy_composition_unprepared`. Read the operation outcome even
when the HTTP request succeeded. See the
[publication protocol](../docs/runbooks/publication.md#approve-and-observe-publication) for the
composition and recovery rules.

## Identity review and Entity Proposals

All 13 identity/admission operations use the generated administration contract.
Every operation requires the owner bearer key and returns JSON with
`Cache-Control: no-store`. Commands accept `application/json`, bounded to 16 KiB
by streamed byte count. Malformed JSON returns 400, unsupported media 415,
oversized bodies 413, invalid typed commands 422, invalid queries 400 and domain
conflicts 409. Domain evidence, category/profile structure, idle-operation and
recovery guards continue to apply after wire validation.

| Operation                    | Route                                                       | Result                                                  |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| List/create Entity Proposals | GET/POST `/v1/entity-proposals`                             | 200 list / 201 current inspection                       |
| Inspect proposal/history     | GET `/v1/entity-proposals/{proposal}`                       | 200 inspection; `after_generation` pages history        |
| Inspect captured evidence    | GET `/v1/entity-proposals/{proposal}/evidence`              | 200 evidence references; `after` pages captures         |
| Admit/link/reject/reconsider | POST `/v1/entity-proposals/{proposal}/decisions`            | 200 current inspection                                  |
| Validate correction          | POST `/v1/identity-corrections/validate`                    | 200 reviewed identities, relationships and digest       |
| List/create corrections      | GET/POST `/v1/identity-corrections`                         | 200 list / 201 immutable decision                       |
| Inspect correction           | GET `/v1/identity-corrections/{correction}`                 | 200 retained decision and reviewed evidence             |
| Inspect canonical identity   | GET `/v1/reconciliation/identities/{identity}`              | 200 retained mappings                                   |
| List identity reviews        | GET `/v1/reconciliation/identity-reviews`                   | 200 retained reviews                                    |
| Resolve review               | POST `/v1/reconciliation/identity-reviews/{review}/resolve` | 200 immutable decision                                  |
| Inspect reconciled Printing  | GET `/v1/reconciliation/printings/{printing}`               | 200 accepted locator, membership and withdrawal history |

Proposal and correction lists require `game`. Correction `after` and proposal
`after_generation` are canonical non-negative decimal strings. Proposal decisions
retain that same representation for `expected_generation`, preserving stored
intent bytes. Creating a proposal retains incomplete intake for review; admission
still requires valid current Card/Printing structure. Reconsideration appends
intake and never overwrites the initial intake or earlier decisions. Omitted or
explicitly null reconsideration content/evidence retains the previous intake;
explicit nulls remain part of the exact replay intent.

Proposal creation/decision replay returns current inspection while preserving the
original immutable intake/decision; subsequent decisions can change its status and
history. Correction creation and identity resolution return their original
immutable decision on exact replay. Reusing an intent for different content
conflicts. None of these acknowledgements approves or publishes a candidate.

Identity inspection accepts `after` and optional `preparation_id`; review listing
accepts `after` and requires `run_id` or `preparation_id`. Preparation-scoped mappings
include their candidate state, while ordinary identity inspection reads
retained canonical mappings. Historical evidence remains inspectable using the
shared retained schemas without rewriting bytes. A split retains every replacement
and never chooses which one represents a consumer-owned copy. Follow the
[owner decision procedure](../docs/runbooks/sources.md).

Early unversioned admission decisions can lack policy and publisher-confirmation
annotations. Their complete historical Card shape remains inspectable; current
decisions retain their required category, applicability and policy fields.

## Historical run operations

New POST `/v1/ingestion-runs/:run/approval` intents return HTTP `410`
`run_approval_retired` without an administration claim, reservation, export or
publication. The CLI reports retirement locally and sends no request. Aggregate
candidate digests and global predecessors cannot be translated into native
owner approval.

The HTTP route remains an observer of an exact persisted historical result or
already reserved publication. Exact result replay returns the original status
and document; changed bindings fail `409`. A retained reservation returns its
pending result, or recovers only that reservation after lease expiry under its
original candidate, approval, predecessor and ownership/recovery fences. It
never acquires a new historical reservation. Inspection, historical rejection,
recovery and reference-safe cleanup remain supported where their retained
records authorize them.

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

For native packages, deletion removes the exclusive manifest under
`catalogue-public-manifests/<catalogue_revision_id>/` and retains shared public
roots, tree nodes, compressed components and the independent backup protecting
them. Historical packages retain their exact `catalogue-exports/<revision>/`
object set. In either layout the manifest is removed last and absence of every
bound removal object is verified. Source and reconciliation evidence,
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

## Collection, candidate and historical states

Collection starts `planning → collecting → parsing`. A collecting run may pause
for capacity, retry, Workflow recovery or owner intent. Resume preserves its
identity and evidence. Only explicit Collection Termination ends a paused run,
retaining its audit evidence and releasing its collection reservation.

A native Reconciliation Operation progresses independently through `preparing`,
`paused`, `sealed`, `abandoned` or `failed`; candidate inspection and publication
remain separate. Its deadline is seven 24-hour periods after creation and never
moves on pause, resume or approval. Artifact preparation progresses through
`preparing`, `retry_paused`, `verified` or `failed`.

Retained run-owned records can still decode
`parsing → reconciling → awaiting_approval → publishing → published`, with
`rejected`, `expired` and `failed` terminal outcomes. These states describe the
historical lifecycle and retained inspection/recovery machinery. They are not
the native publication protocol and do not authorize a fresh aggregate approval.

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

## Release states

A production release follows:

```text
requested → preflight → migrating → deploying → smoke_testing → succeeded
```

Any non-terminal state may become `failed`. One release may be active. The
workflow rechecks the expected Catalogue Revision, idle ingestion, healthy
recovery, bindings, migration level, and recovery bookmark before mutation.
After a migration, failure is corrected by a compatible roll-forward unless a
schema-compatible Worker rollback is proven.

Bearer keys retain primary/replacement slots. There is no current
`credential rotate`, `verify` or `revoke-old` CLI command; historical credential
fields in the snapshot schema do not expose an active rotation workflow.

## Source authority

`GET /v1/source-registry` identifies installed game/source/profile/adapter bindings;
`GET /v1/source-authorities` returns scoped designations. Registration, transport
permission and publisher ownership do not grant Source Authority.
`POST /v1/source-authorities` accepts:

```json
{
  "game": "one-piece",
  "locale": "en",
  "release_region": "OCEANIA",
  "area": "card_facts",
  "source_lineage": "limitless-one-piece-en",
  "expected_generation": 0,
  "rationale": "Owner selected this source for the declared scope",
  "idempotency_key": "one-piece-card-authority-selection"
}
```

Areas are `card_facts`, `printing_details` and `corrected_card_content`. The expected
generation is a non-negative JSON integer. Success retains an append-only
decision and incremented generation. Exact replay returns that decision; changed
key reuse or stale generation returns 409; invalid scope returns 422. Changes
require idle collection, review/publication, recovery and release. Selected
authority cannot silently fall back when its evidence is missing. Decisions stay
in administrative backup/recovery data, outside consumer exports.

The [source procedure](../docs/runbooks/sources.md) covers collection, admission,
identity decisions and Curated Revisions. Official Erratum observation shapes
are defined by [their schema](schemas/official-errata.schema.json). Publisher
corrections preserve Printed Rules Text; publication uses the inspected candidate
and does not activate/recalculate corrections when an applicability date passes.

## Source and collection HTTP

All 16 source/collection operations are defined by the shared Hono registrations
and the generated [administration specification](admin-openapi.json). Authority
and lifecycle commands use JSON integer `expected_generation`; capacity commands
use JSON integer capacities and generations. Unknown JSON fields are rejected.
Resume accepts no body or an empty JSON object. Other commands require JSON.
All command bodies retain the shared 16 KiB bound and problem responses.

Creation and linked retry return 201 with `card-keepr-evidence-acceptance@1`.
The receipt's `state: collecting` records initial acceptance, never current state.
Its retained run identity, initial plan, start time and predecessor link replay
unchanged after pause, completion or termination. Creation does not dispatch work.
`Location` and `links.status` identify the absolute evidence-status resource;
`Retry-After` is 1 second. Resume returns 202 with
`card-keepr-collection-dispatch@1`, its deterministic Workflow Attempt, currently
observed Workflow status and the same status link. A repeated resume reacquires
the current attempt; it cannot resume a terminal run. Inspect status to distinguish
capacity, retry and Workflow pauses, collection completion and later publication.

Pause, capacity extension, authority and lifecycle decisions replay their retained
results. Termination retains its immutable decision and reports current reservation
release separately in `active_run_released`. Extension leaves the run paused.
Collection Termination preserves evidence and only a new linked retry may collect
again. The CLI's zero exit acknowledges a successful source command or inspection;
its acceptance text directs the owner to resume/status and does not claim successful
collection or publication.

Snapshot content streams exact retained bytes with the original media type.
Observation content streams retained JSON, including historical adapter-owned
fields. Both carry immutable private caching, Content-Length and digest ETag;
neither route buffers its body. Parsing appends an immutable observation set for a
new key and replays the same set for the same intent. Explicit record import seals
bounded retained records without rewriting the original evidence. Metadata, status
and command JSON responses use `Cache-Control: no-store`.
