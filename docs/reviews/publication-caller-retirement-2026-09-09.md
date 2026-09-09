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

The old unchanged-refresh lifecycle scenario remains an explicit pending native
migration. Its no-extra-revision/export expectation is being checked alongside
the Product and provenance callers; the checkpoint probe does not settle that
policy. The candidate-expiry scenario still asserts the exact seven-day boundary
and now expects a new expired aggregate intent to receive the same intentional
410 retirement as other unreserved intents.

## Faithful Workers backup fixture

The fixture now exports the current Miniflare `CATALOGUE_DB` using the installed
Wrangler local export mechanism (`PRAGMA miniflare_d1_export(?,?,?);`). The
Miniflare `V4FetchHandler(request, miniflare)` callback supplies the exact owning
runtime; a WeakMap keeps each runtime's transport state separate. Exported SQL
contains actual schema and rows and fails if virtual tables remain, matching
[Cloudflare's export boundary](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
The fixture imports uploaded bytes into an independent Node SQLite database and
executes every verification/reconstruction query there. It never echoes expected
snapshot values. The original ambiguous probe-table failure injections remain.
Node SQLite is imported only by the test configuration, not the shared publisher's
Worker bundle. No production recovery checks, schema or storage layout changed.

The native approval helper now waits for the actual backup attempt to reach
`verified`, rejects `failed`, and checks its revision matches the publication.
The existing 15-second observation bound is unchanged. An optional fourth header
argument affects only the approval POST, preserving explicit test clock scenarios.
The repeated-publication proof captures evidence after preparation completes
parsing, verifies unchanged source bytes/coverage through publication, observes
both real backups and starts another collection after the recovery fence clears.

A first probe used the host default Node 26.3.0 and exited naturally in 6.50s.
Both publication/restore operations completed; the remaining assertion compared
pre-parse incomplete coverage with completed coverage. Moving that observation
to after preparation corrected the test without changing production behavior.
The Node 22.23.2 focused rerun passed 7/7 selected cases across two files in 12.53s;
20 cases were unselected. Two independent SQLite contracts also pass, proving
restored facts/FTS reconstruction, database isolation and failed-import rollback.
Typecheck and focused Biome checks pass. Full logs retain eight workerd
canceled/hung background warnings; they are not silently suppressed. Broader
caller/provider runtime validation and final independent reviews remain open.

The exact committed provider `a8dafc76f147e112a64edcdc5625355ccdeb819d`
was then rerun on Node 22.23.2: 7/7 selected cases passed across two files in
13.08 seconds, 21 unselected (the pending old no-change scenario was restored).
All processes exited naturally. The lease was handed to the five-file migration
agent after confirming no Workers/Vitest process remained. Raw red/green logs
and SHA-256 digests are retained in the evidence manifest. Independent provider
reviews are requested against fixed `a0968e6e..a8dafc76`.

Both independent provider reviews against `a0968e6e..a8dafc76` are clear:
coordinator Spec found no material issue; capacity agent Standards found no hard
violation or actionable smell. These test-host SQL allocations prove restore
behavior; they are not Worker isolate capacity measurements.

The Errata target-guard and evidence-retention repository tests now seed through
real native preparation/publication. Their existing invalid-target, sibling
rollback and every-observation retention assertions remain intact. Typechecking
is required before their dedicated runtime selection; no runtime claim yet.

## Native export reader and historical materializer distinction

`378e60756ad8f1f2bf350b5db85f046695abe2b6` updates the existing export fixture
reader to follow native public routes and all four-component pages, verifying
manifest checksums, compressed/uncompressed sizes and digests, and record counts.
It preserves legacy direct decoding and returns actual native public records.
`exportManifest` returns an honest native first page with its cursor. A 32-Card
case proves full traversal, exact public IDs/type/game, failed corrupt-manifest
references, missing components and same-size damaged gzip, then restores all
bytes. Exact Node22.23.2 runtime passed 1/1 in 9.01s. Coordinator Spec and capacity
agent Standards independently reviewed fixed `88c41fbd..378e6075`; both are clear.

The preceding three-file run passed the reader and duplicate-relationship case
but failed two attempted native seed migrations in 16.90s. Those tests exercise
retained historical materializer tables, which native publication does not fill:
Errata target lookup was null and old evidence-retention counts were zero. Their
assertions are retained. They require actual pre-retirement reservation/export
fixtures and the existing recovery observer, not production writes into obsolete
tables. The coordinator authorized a dedicated historical fixture for that scope.
Both failed and green logs are retained with digests. All runs exited naturally;
the runtime lease was handed to the native ambiguity diagnosis lane.

The historical helper at `b2caf3a9` is prepared with exact retained candidate and
catalogue digests, lifecycle-bound export bytes, verified historical image bytes,
an explicitly seeded old reservation, the original expired-lease observer and
exact replay. It then waits for the real backup checkpoint. The two retained
materializer tests now use that fixture; their prior native-seed failure is not
hidden. Typecheck passes; dedicated runtime is queued behind the ambiguity lane.

All current-publication callers in `identity-corrections.spec.ts` now prepare
native candidates with explicit predecessor revisions. Existing collection keys,
owner attestations, correction decisions and all eleven cases remain. Controlled
fault cases capture the real native creation/resume dispatch, drive it through
the existing Workflow driver, and read phase checkpoints through the existing
integrity-checked repository seam. They retain four failed retries, intermediate
cursor and 100-call bounds, deadlines, immutable old exports and exact identity
assertions. The historical empty-correction-pin case retains its legacy resume
seam. Typecheck passes; native runtime proof is still pending.

Historical provider `ad42319e` passes all three retained materializer cases across
two files on Node22.23.2 in 5.66 seconds at the exact committed head. The earlier
5.30-second run passed one case and failed two before recovery because the
evidence-run summary intentionally omits the candidate digest. A 3.04-second
state probe confirmed the run was awaiting approval; the existing `/candidate`
inspection supplies the exact immutable binding. That fixture-only correction
passed in 6.33 seconds before commit, then passed the fixed-head run above.
The helper verifies original image/export bytes, recovers an actual expired
historical reservation, checks exact replay and waits for actual SQL restore
verification. Every original Errata/retention assertion passes without filling
legacy tables from native publication. Full red/green logs and digests are
retained. Background canceled/hung diagnostics remain visible; every run exited
naturally. Independent review of the historical provider is still required.

The four-file historical provider is independently clear against fixed
`664c51e5..ad42319e`: coordinator Spec and capacity-agent Standards found no
actionable findings. Reviewed idle-R2 reset provider `c455f841` was cherry-picked
as `a11f10d7`, retaining all four configured Workflow bindings before the pending
identity suite.

`source-refresh-publication.spec.ts` now observes actual collection-triggered
native candidates and approves their exact manifests. The existing decision to
decline the first supplemental intake is expressed as native abandonment. All
checks remain: same consumer revision for no-change refresh, supplemental carry,
immutable earlier checks, withdrawal/reinstatement, incomplete 100-to-1 coverage,
independent Errata scope, and revalidated/reverted provenance dates. Failed
collection remains a failed collection rather than a fabricated candidate.
Typecheck passes; the five-case runtime is pending, including the separately
diagnosed native no-change contract gap. No global timeout changed.

The reviewed native prior-identity provider `9a43a400` is incorporated as
`43c80966`. Its production files are byte-identical; the sole test conflict was
resolved to the exact reviewed operations file, including its earlier native
fixture migration. The independent provider family passed 58/58 separately.

The normative observation-count test now prepares native 100/124/149-record
candidates with exact predecessor revisions, preserving the absent warning at
24 and exact warning at 25. Historical search-repair projection tests explicitly
seed real retained reservations through the proven recovery helper. The obsolete
new aggregate over-budget approval now asserts the documented 410 retirement,
unchanged run/failure state, catalogue head and immutable objects. Its former
new-writer capacity error is intentionally retired; no limit was increased.
Focused formatting and typecheck pass; these changed selections await runtime.

The exact `cd0fc2d0baaee613f46deccd158422db865a2844` identity file ran all
11 cases naturally in 111.39 seconds on Node22.23.2: nine passed and two failed.
All five controlled interruption/cursor cases pass with original collection and
identity keys; no immutable-object collision occurred. The failures preserve
meaningful semantics: a reviewed known-number merge exports two Printings instead
of the exact one retained identity, and the next candidate after a reviewed Card
split pauses because prior compatibility still names the former Card. The native
identity provider owner is diagnosing both at those exact existing tests.
No fixture oracle is weakened; neither failure is called a harmless flake. Full
raw log and SHA-256 remain alongside the background cancellation/RPC-stub warnings.
The runtime lease was returned to the coordinator with no Workers process left.

The mixed-game empty-plan case now prepares and inspects each native game
candidate independently, checks actual retained disappearance warnings in both
plan orders, preserves the original decision to decline the first pair, and
approves the second pair with their exact game predecessors. Fusion World
locator history remains bound to its actual publication. Historical export
repair assertions and explicit retired approval remain separate. Typecheck and
focused formatting pass; the export/repair runtime selection remains queued.
