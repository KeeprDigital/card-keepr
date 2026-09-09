# Publication caller retirement inventory and transition

Issue #274, caller lane, fixed base
`b28d2afc7dd4d37bfcb7a3c59ac62be5500bdcba`.
This document records intended transitions before deleting any implementation.
ADR 0015 and CONTEXT require approval of one complete immutable game candidate,
its exact game predecessor, original seven-day deadline and atomic composition.
No live operation, reset, bucket change or Go-Live is part of this work.

## Entry points and transition

| Existing entry | Current behavior | Intended transition |
| --- | --- | --- |
| CLI `run approve` | Posts run ID, aggregate candidate digest and global predecessor to run approval. | Explicit retirement error pointing to `game-candidate inspect`, `publication-preparation start`, `publication approve` and `publication status`. It cannot infer a game, manifest, generation or owner approval. No network mutation. |
| POST `/v1/ingestion-runs/:run/approval` | Synchronous whole-catalogue publication, aggregate allocation guard, legacy backup dispatch waiter. | Explicit HTTP 410 `run_approval_retired` with native transition guidance. It never silently creates a native approval. |
| `approveRun` facades (`ingestion.ts`, `index.ts`) | Export the old writer to routes and tests. | Remove old new-approval implementation/exports after caller migration. |
| GET run candidate / CLI `candidate inspect` | Historical aggregate candidate inspection; used by reconciliation diagnostics and old-run inspection. | Preserve read-only retained inspection; document that it is not approval input for native publication. Native review uses exact game candidate and manifest. |
| Run rejection/retry/cleanup and run status | Persisted legacy run lifecycle, cleanup retry and inspection. | Preserve auditable historical states and reference-safe cleanup. Native candidate abandonment and publication resume use distinct existing operations. |
| Native game-candidate / publication-preparation / publication operations | Bounded durable preparation and exact whole-game approval. | Remain supported. CLI help and contracts must expose start, 202 pending acknowledgement, unchanged idempotent acknowledgement, separate status and resume semantics. |

New approval moves intentionally to `/v1/publications/start`: the caller supplies
`candidate_id`, `manifest_digest`, `expected_game_revision_id`, candidate
`generation` and `idempotency_key` from the completely inspected sealed candidate.
202 means approval persisted and work is pending, not publication complete.
Replaying that exact key returns the original acknowledgement; status observes
current progress. Conflicting keys, wrong predecessor/generation, missing
inspection/preparation, expiry and recovery fencing retain native error behavior.
Resume uses operation generation and a separate intent. There is no API-level
translation from an old aggregate digest to this authorization.

A legacy current catalogue lacking prepared composition members still fails
`publication_legacy_composition_unprepared`. Its separately authorized #239
re-baseline is required; caller retirement does not fabricate native roots.

## Production ownership and reachability

`ingestion/publication-lifecycle.ts:approveRun` and `approveRunAttempt` alone
start new aggregate publication. They call `assertPublicationAggregateBudget`
(the 16 MiB aggregate path), `assertBuiltPublicationBudget`, reserve/write/verify
export and base64 Printing Image helpers, then legacy commit/no-change recipes.
These new-writer-only functions are deletion candidates, not targets for larger
limits. Their complete call graph must be checked again after deletion.

`reconcileAbandonedPublication` remains called by run administration and status.
It verifies retained candidate/digest/approval metadata, immutable export bytes,
writer ownership, recovery and predecessor guards before finishing an already
reserved historical publication or failing it into reference-safe cleanup.
Its verification, commit and cleanup dependencies are retained where reachable.
Publication repository functions also have query-materialization, core-guard,
run-event and historical-recovery test consumers; file names alone cannot justify
deleting them. Public native export preparation remains independently routed.

The image lane owns only streamed image evidence/reconciliation and its new
image-specific tests. Second-bucket storage, immutable keys, serving references,
backup/restore closure and large text/page bounds are unchanged by this caller
lane. PR #277 already removed the unused observation run argument and duplicate
wrappers; that cleanup is not repeated.

## Caller census at the fixed base

Direct old-approval runtime consumers:

- `production-release-bootstrap.spec.ts`, `lifecycle.spec.ts` (including direct `approveRun` calls).
- `game-candidate-integrity.spec.ts`, `reconciliation-workflow-binding.spec.ts`.
- `reconciliation-helpers.ts` (shared `approve` helper), `reconciliation-provenance-locators.spec.ts`.
- `errata-rules-text.spec.ts`, `reconciliation-scale-and-recovery.spec.ts`.
- `reconciliation-completeness-profiles.spec.ts`, `reconciliation-progress.spec.ts`.
- `identity-corrections.spec.ts`, `published-run-rebuild.spec.ts`.
- `runtime-capacity-pause.spec.ts`, `runtime-collection-termination.spec.ts` retain negative lifecycle checks; retirement changes their endpoint contract intentionally.

Acceptance harness consumers:
`catalogue-publication-ingestion-harness.ts`, `retained-evidence-base-harness.ts`,
`combined-card-keepr-runtime.ts` attach legacy approval backup waiters. CLI contracts
are in `acceptance/ingestion-cli.test.mjs`; the prototype OpenAPI is read-only and contains no approval operation to retire.
Its administration schema retains historical approval records and must continue
to decode them. Existing runbook
native workflows are `atomic-game-publication.md`, `publication-preparation.md`
and `one-piece-two-source.md`. Earlier audit/planning documents remain historical.

The shared test approval helper must use actual native candidates and public
preparation/inspection/approval/status seams. It must preserve pending, replay,
error and result checks; a test-only translation is not an exposed owner shortcut.
No direct old approval caller is allowed to remain as a way to obtain current
published data. Recovery tests may construct exact historical durable state to
exercise recovery, without keeping a callable new aggregate writer.

## Planned verification and status

Implementation has not started at this inventory commit. TDD begins at CLI and
public route retirement/native approval seams, followed by focused typechecks
and source reachability checks. Runtime tests require the coordinator's host
lease; the toolchain lane currently owns it. Final evidence must name exact
commits and any interrupted/failing checks, independent Standards/Spec reviews,
native approval/publication/image/export/cleanup tests and actual restore proof.


## First implementation checkpoint

The CLI now returns explicit `run_approval_retired` guidance before any network
request. All 22 CLI contract tests pass, including the initial failing retirement
regression. Help now names native publication and preparation commands.

The old API implementation now observes only historical outcomes/reservations:
exact persisted success/problem replay remains unchanged, changed reused keys
retain 409, and an existing publishing reservation must match key, digest and
predecessor before observing its prior active claim or invoking historical
recovery. An unreserved new intent gets HTTP 410 without acquiring a claim,
reserving a writer or persisting an outcome. This is deliberately not a native
approval translator. The facade now names the retained function `observeHistoricalRunApproval`;
its aggregate writer has been deleted. The unused Printing Images argument has
been removed from this observation path.

Deleted sole-new-writer code includes aggregate/export allocation guards, the
16 MiB constant, transient image base64 conversion/writing, new export writes,
new reservation helper, old no-change publication and unreserved failure helper.
Historical prefix verification, verified commit, owned cleanup and pending/replay
primitives remain. Typecheck passes after correcting intermediate removed-import
errors. The new public/runtime no-write regression and existing exact reserved
publication recovery test are queued for the host lease; they have not run yet.
Supported test callers still need native approval migration, so this checkpoint
is not ready for integration or issue completion.

The focused historical regression now checks exact pending and persisted replay
against changed run ID, digest and predecessor, and rejects a fresh key against
an existing reservation. Typecheck and focused Biome checks pass at this
checkpoint; the runtime lease remains queued, so these assertions are not yet
reported as passing. The supported native fixture helper and full owner journey
are committed at `3383b02c`, with runtime proof likewise pending.

Independent early review of `b28d2afc` through `464b2af8`: coordinator Spec
reported no actionable production-contract findings; toolchain Standards reported
zero hard violations and zero actionable smells. This is an early code checkpoint,
not the completion review or runtime approval. The retained-reservation fixture
is now explicit about whether an original writer claim exists, because the old
fixture depended on the removed writer acquiring one implicitly. Both variants
assert the observer leaves claim ownership unchanged while pending.

## Focused runtime checkpoint

The native fixture helper is proven at `20661b33`. The focused selection passes
4/4 cases in 4.64 seconds: a new unreserved intent creates no writes; an already
reserved historical intent preserves its original claim or remains claimless;
both recover the exact verified export and preserve bound replay; and a source
collection prepares, inspects and publishes an actual native candidate, then
replays the original approval acknowledgement and rejects changed reuse.

The first run at `b32abca9` passed three cases and failed the claimless variant
because both parameter variants reused the same retained fixture/approval keys.
The corrected test uses distinct exact intents; no production behavior changed.
Both runs exited naturally. Their complete compressed logs and digests are in
[evidence](evidence/publication-caller-retirement-20260909/manifest.json). The green
run still logged three workerd canceled/hung background requests around historical
backup dispatch. These diagnostics are retained and passed to the reliability
coordinator; focused approval success is not backup completion or restore proof.

The other 27 lifecycle cases were unselected. Seed-only native migrations in
Product cursor, Curated Revision fanout and reviewed Printing matches are
committed at `3dccd78a` with typecheck/Biome checks, but their runtime cases have
not run. Remaining caller migrations, complete native/provider coverage, final
independent reviews and full validation remain open. The host runtime lease was
returned after verifying no Workers/Vitest process remained.

## Native caller migration ledger

The old stale/mismatched-new-approval and concurrent-new-approval lifecycle cases
move to `publication-caller-retirement.spec.ts`. They now supply the actual sealed
candidate ID, manifest, game predecessor and generation. The owner boundary
rejects extra deadline fields and wrong manifest/predecessor/generation without
changing the candidate; simultaneous exact approvals retain one original 202
acknowledgement, and explicit dispatch publishes that exact intent. Historical
replay remains separately exercised in lifecycle tests. These additional native
assertions are prepared after the four-case green checkpoint and await rerun.

`reconciliation-missing-images.spec.ts` now prepares an actual native candidate
from retained collection, inspects its bounded records and exact warnings, checks
the native preparation's retained warning checkpoint, and uses native approval.
It retains every tolerated image-failure scenario and the 32-warning continuation
assertions. It has typecheck/Biome validation; runtime is pending.

Two writer-only lifecycle cases retire with their implementation: synchronous
new-writer late-put compensation and new-writer prefix-adoption races. No current
entry point can launch those writes. Existing historical recovery validates the
exact immutable export and prefix; registered-prefix cleanup fencing, unexpected
recovery objects, cleanup retry and CAS replay remain covered. Cleanup CAS and
registered-prefix tests now inject an explicit pre-retirement reservation and
observe its failed recovery, instead of invoking the deleted writer to create
their seed. Their runtime validation remains pending.

## Repeat-publication blocker

At `929bc80e`, the next focused runtime selection exited naturally in 24.09
seconds: six passed, one failed, 21 unselected. Historical no-write, both exact
claim cases, cleanup CAS and registered-prefix fencing pass. Native extra-field,
manifest/predecessor/generation, concurrent acknowledgement and first-publication
checks pass. The second native publication remains `waiting_backup` after its
15-second observation window, while the backup Workflow repeatedly reports
`Restored composition snapshot differs`. The comparison was not weakened and no
verified checkpoint was synthesized. Full evidence is retained beside prior logs.

The Workers fixture Cloudflare API in `test/support/fake-publisher/cloudflare-api.ts`
serves a comment-only SQL export, discards the upload and answers verification
with hardcoded legacy fields or empty rows. It has no native composition-state,
schema or table-page data. Thus it cannot prove the native restore checkpoint.
This is a concrete fixture prerequisite for repeated publication callers, not
evidence of a production restore defect. The coordinator separately reported
real SQLite-backed native composed acceptance passing. Its
`acceptance/helpers/native-recovery-cloudflare.mjs` is the existing faithful
export/import/query model; adapting Workers fixtures needs scoped work and proof.
