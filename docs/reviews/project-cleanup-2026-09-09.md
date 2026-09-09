# Project cleanup — 9 September 2026

Implementation commit: `d6761a9c`, based on main `51e1c83f`.
The [audit](project-audit-2026-09-09.md) records the earlier state; the
[execution handoff](../plans/private-launch-waves.md) and current GitHub issues
describe the reconciled backlog.

## Changes

- #270: use the persisted Source Request role when parsing a Source Snapshot.
  An image-labelled document response fails explicitly and retains its raw
  evidence. Planned images retain their existing integrity checks and replay.
- #253: run the existing ingestion stress selection directly. There are no API
  stress files; selecting them first previously prevented ingestion execution.
  Full stress success remains outstanding.
- Share the adapter object-member error wrapper and remove the unused
  observation-reader run argument. Existing selection and verification remain.
- Update the README and retain the audit evidence and ordered private-launch
  handoff. Preserve all 26 original local changes before updating the ordinary
  main checkout; #272 owns the separate six-file toolchain reconciliation.

## Validation

Local environment: macOS arm64, Node 26.3.0, lockfile-installed dependencies:
Vitest 4.1.10, Workers test pool 0.18.8, Wrangler 4.114.0, Miniflare
4.20260722.0 and workerd 1.20260722.1.
CI uses Node 22; local results do not substitute for required release checks.
No live deployment or resource mutation was performed.

| Check | Result |
| --- | --- |
| Typecheck, generated Worker types, document validators | Passed |
| Lint | Passed; existing warning/info output remains |
| Formatting of all staged supported files; whitespace check | Passed |
| Catalogue cycles and import boundaries | Passed |
| API and ingestion deployment dry runs | Passed |
| New role regression and existing source-record intake | 18/18 passed across two files |
| Domain suite | 246/246 passed across 44 files |
| API suite | 95/95 passed across 13 files |
| Ingestion suite | 739 passed, 14 failed across 88 files; 484 seconds |
| Acceptance | 344 passed, 1 deliberately terminated scenario, 1 opt-in skip; see ledger below |

The new regression was observed failing before the production fix and passing
afterward. The whole default selection was attempted once, with domain, API,
ingestion and acceptance phases run sequentially so an earlier failure did not
silently omit later phases. Acceptance used file concurrency 1. The completion
ledger below records the broader result separately from focused success.

The corrected stress entrypoint reaches `runtime-host-pacing.stress.spec.ts`,
which currently fails at line 43: the timestamp subtraction is `NaN` instead of
at least 500 ms. This is unresolved #253 evidence, not proof that production
host pacing is too fast. A complete green scheduled/manual stress run is still
required. This cleanup did not attempt the entire separate stress selection.

Full local logs are retained outside Git in
`/tmp/card-keepr-cleanup-full-20260909`, with focused stress output in
`/tmp/card-keepr-cleanup-stress-entrypoint.log` and static check output in
`/tmp/card-keepr-cleanup-static-20260909`. These are local diagnostic files,
not durable CI artifacts or portable release proof.

## Standards

Independent review found no documented-standard violations or remaining
actionable smells in the cleanup. The repository query stays in the repository
layer, joins both run and request identities, and uses the existing role type.
The shared adapter wrapper retains parse-error classification and propagates
other failures unchanged.

## Spec

Independent review found no blocking omissions or incorrect implementation in
the #270 fix and scoped cleanup. The five new cases cover the original defect,
misleading request identifiers, valid image replay, wrong media type and empty
image bodies. #253's entrypoint correction is complete in code; its full-run and
scheduled/manual green-run criteria remain open. Both reviewers were read-only
and relied on the coordinator's reported test execution.

Standards: 0 findings. Spec: 0 blocking findings; #253's wider acceptance remains.

## Ingestion failure ledger

The full default ingestion selection completed with 8 failing and 80 passing
files. Several timeout/collision families also appear in the earlier main CI
run. The exact baseline equivalence of every local failure has not been proven;
#271 must classify them before integration.

- `apps/ingestion/test/evidence-cleanup.spec.ts`: owner reclaims a positively inventoried abandoned preparation orphan without traversing shared roots.
- `apps/ingestion/test/evidence-cleanup.spec.ts`: a conclusively deleted staging key can hold the same bytes for a new preparation; old delete tickets cannot cross incarnations.
- `apps/ingestion/test/evidence-cleanup.spec.ts`: an ambiguous staging deletion keeps its ticket open and prevents reuse despite another HEAD showing absence.
- `apps/ingestion/test/evidence-cleanup.spec.ts`: an unrelated staging key progresses while a prior delete outcome remains unknown.
- `apps/ingestion/test/evidence-cleanup.spec.ts`: concurrent conflicting staging starts cannot silently share an idempotency key.
- `apps/ingestion/test/game-reconciliation-operations.spec.ts`: a native source change retains reconfirmable curated diagnostics without failing the collection.
- `apps/ingestion/test/identity-corrections.spec.ts`: reviewed identity application prepare through durable bounded groups.
- `apps/ingestion/test/publication-preparation.spec.ts`: an exhausted stale Workflow cannot pause a newer owner's sequence.
- `apps/ingestion/test/publication-preparation.spec.ts`: publication preparation verifies retained inspection metadata as part of the whole manifest.
- `apps/ingestion/test/identity-corrections.spec.ts`: reviewed identity lookup prepare through durable bounded groups.
- `apps/ingestion/test/reconciliation-prior-state-cursor.spec.ts`: prior Cards from 'curated-conflict-fanout-base' resume through durable returning groups ('withdrawal_diagnostics').
- `apps/ingestion/test/reconciliation-progress.spec.ts`: admission selection is frozen without an unbounded operation-start write.
- `apps/ingestion/test/reconciliation-workflow-binding.spec.ts`: parsed observation count warnings use the normative absolute threshold.
- `apps/ingestion/test/source-refresh-publication.spec.ts`: unexplained substantial coverage loss blocks completeness rather than becoming ordinary disappearance.

One concrete diagnostic lead: the staging-cleanup fixtures abandon preparations
without a fixed terminal time. Migration 0024 stamps that time from SQLite's
wall clock, while those tests request cleanup at a hard-coded
`2026-10-09T00:00:00.000Z`. On this run's date, that can fall before the required
30-day boundary. Fix the fixture clock at its existing seam and confirm the
baseline/result; weakening the production retention guard would be incorrect.

## Acceptance bounded-run ledger

All 68 acceptance files were selected. Node reported 346 tests: 344 passed,
1 failed due to the coordinator termination below, and 1 skipped. The phase
exited 1 after 2,128 seconds; it is not an all-green acceptance result.

The coordinator stopped `acceptance/riftbound-catalogue.test.mjs` after 10 minutes
58 seconds to bound this cleanup's verification. The other acceptance files
continued. This is an incomplete scenario, not a demonstrated assertion failure
or a passing Riftbound catalogue rehearsal. #271 retains the completion gap.
The smaller bounded Riftbound publication/actual-restore scenario passed.

The retained One Piece two-source scenario passed, including publication,
authenticated consumer reads and actual backup restoration, in about 676 seconds.
The default run skips the opt-in synthetic Product capacity probe; #268/#275
still require their independent capacity evidence.

The stop record is `/tmp/card-keepr-cleanup-full-20260909/riftbound-bounded-stop.json`.
Partial Riftbound state remains at
`/private/var/folders/h9/r2hp35sx2bs4v69vcsxsls900000gn/T/keepr-real-riftbound-uZaC0J`.
The two local workerd stack samples are
`/tmp/card-keepr-cleanup-workerd-sample.txt` and
`/tmp/card-keepr-cleanup-riftbound-workerd-sample.txt`. They are diagnostic process
samples and do not establish a peak for an individual Worker isolate.
