# Private-launch workstream cleanup — 10 September 2026

This records completion and reconciliation of work already in progress. It is not launch approval or evidence of a live deployment.

## Preserved work and consolidation

Before integration, tracked/index changes and untracked files from the dirty worktrees were copied into the verified recovery archive outside the repository. A Git bundle preserves unpublished commits. The original dirty worktrees were retained.

- [PR #296](https://github.com/KeeprDigital/card-keepr/pull/296) landed the bounded testing baseline; all nine required checks passed.
- [PR #277](https://github.com/KeeprDigital/card-keepr/pull/277) landed the audited cleanup and source-request-role correction, closing #270; all nine checks passed.
- [PR #297](https://github.com/KeeprDigital/card-keepr/pull/297) reduced disk synchronization cost in the disposable SQL reconstruction fixture. The hosted comparison did not reproduce the earlier slow run, but the adjusted fixture passed three hosted probes and full CI.
- [PR #298](https://github.com/KeeprDigital/card-keepr/pull/298) moved database migration/seed setup outside the Printing backfill assertion deadline. It preserved the real replay and all query assertions; full PR CI passed.
- Actual main commit `1998ab53` passed [all nine checks](https://github.com/KeeprDigital/card-keepr/actions/runs/34428352474).
- PRs #283, #288, #289, #290, #294 and #295 were closed as superseded by [integration PR #284](https://github.com/KeeprDigital/card-keepr/pull/284), after verifying their remote heads were ancestors of its pushed consolidation commit. Their reviews and source branches remain recoverable.
- Old schema-freeze PR #204 was closed as superseded. Its identifier-suffix decision remains prior art for #136. No GoLive marker or migration fold was performed.

## Integration corrections

The merged streams needed shared native publication history: per-game predecessor bindings, locator and membership history, stable identity comparisons, withdrawal checks, disappearance warnings and accepted source freshness. The corrections preserve private evidence separately from consumer revision identity, and traverse retained history in bounded returning work units.

Tests that exercise current publication now enter the native candidate/publication owner. Tests whose assertions concern retained legacy SQL projections, interrupted old export writers or legacy cursor recovery remain explicitly historical fixtures. These fixtures stage immutable old-writer evidence and use the supported recovery boundary; they do not restore new aggregate approval.

Native acceptance uses real SQL export/import and backup verification. The synthetic owner/source journeys use a finite administration request budget matching the existing native Erratum fixture. Their requests remain paced; rate-limit behavior has its own tests.

## Validation status

The actual main baseline is green at `1998ab53`. Integration is a separate gate. [Run 34429179293](https://github.com/KeeprDigital/card-keepr/actions/runs/34429179293) at `6c20bc72` passed checks (including API), domain and acceptance shard 3, but failed formatting and two file-wide acceptance deadlines. All three ingestion jobs reached their twelve-minute caps after reporting test failures. Those results must not be described as a green integration.

Follow-up corrections preserve the thirty-second ingestion and two-minute acceptance limits:

- The identity CLI fixture uses the same finite 300/minute administration allowance and 250ms pacing as the other native owner journeys. It passes in 32.5 seconds locally.
- Independent Erratum authority/shape scenarios now have their own file, with shared fixture helpers. Their assertions are unchanged. The complete retained Erratum CLI/HTTP/export journey passes in 73.6 seconds; all four selected acceptance tests pass together.
- SourceBucket provenance again checks the matching Printing membership's relationship identity, observation ID, currentness and last-observed revision.
- Administration history has explicit 1,024-record/1 MiB response bounds and returns `409 source_history_capacity_exceeded` above either bound. Retained lifetime evidence is unchanged. Regression coverage includes the response boundaries and continued access to retained evidence.
- Gundam warnings build a two-lineage summary per Printing in a checkpointed scan, then emit warnings with a separate durable cursor. No nested lifetime scan remains in that warning path.
- Selected semantic suites opt into the existing direct preparation driver with real HTTP owner logic and D1/R2. This controls preparation scheduling only; publication, SQL export/import and backup retain real bindings. Dedicated scheduling and acceptance coverage remain separate. This applies the layer separation already required by `docs/testing.md`.

The next hosted run, [34430459915](https://github.com/KeeprDigital/card-keepr/actions/runs/34430459915) at `8c55c4d4`, passed checks/API, domain and all three acceptance shards. Formatting failed on two new helper import layouts; those are corrected. Its ingestion outcome remains a separate gate. A full local selection of the five opted-in semantic files passed 47 tests and exposed one fixture mistake: independent Gundam locale orders shared accumulated candidate records and selected an unrelated Printing. They now run as independent parameterized tests, preserving the exact assertions and 15-second deadline; both pass.

Completed preparation seeds and ordinary refreshes in the progress, game-operation, identity-correction and Erratum files use the explicitly named controlled helper. Subsequent fault drivers, race barriers, publication and backup bindings are unchanged. Four previously failing cases pass together locally, including their original fault assertions. Independent review found no lost timing or scheduling assertion.

The targeted history selection passed six tests, the controlled-preparation comparison passed three scenarios, and the shared owner/source helper passed all three journeys. Two independent review axes found the history corrections and controlled semantic fixture boundary acceptable. Types, lint and catalogue boundaries passed locally before the controlled-driver change; its typecheck also passed. Final required checks on the complete resulting branch remain the merge gate, followed by checks on the actual main commit. The live PR checks are the authoritative final result.

### Backup verification cost

The next full ingestion attempt at `8c55c4d4` again reached all three job caps. Controlled preparation alone did not resolve the hosted failures. Operational logs attribute about 17 seconds of one failed lifecycle test to three backup steps. Temporary local instrumentation found 1,641 schema queries per backup (roughly 2,000–3,000 total verification queries); SQL export and import themselves took under 0.2 seconds combined per backup.

The application now scans schema records in pages of at most 32 entries and 1 MiB UTF-8 JSON, rather than one verification request per entry. It hashes the same ordered canonical rows and newlines, preserving existing snapshot identity. Both source capture and actual restored-database verification use the bounded scan. Foreign keys, table contents and final exact snapshot equality remain checked. Oversized rows fail explicitly rather than disappearing from the census.

Twelve domain verification tests pass, including equivalence with single-row snapshots, corruption rejection and actual SQLite paging across the byte boundary. The representative Gundam lifecycle test, including real backups, improved from 14.03 to 9.52 seconds locally (16.12 to 11.32 seconds including startup). This is a local comparison, not a hosted performance claim. Both review axes found no lost verification; temporary instrumentation was removed.

The dependency audit found no production dependency advisories. A compatible `fast-uri` patch updates the lockfile from 3.1.4 to 3.1.7. Remaining development-tool advisories concern the installed Cloudflare/Miniflare dependency chain; the automated proposed major/alpha replacements are not applied as part of cleanup.

## Launch work intentionally left open

- #236 / draft #246: isolated dev setup has existing implementation, but the account/credential isolation choice and live first-install proof remain open. No resources or credentials were provisioned during cleanup.
- #237, #238, #239 and #240: staging, production, operational handoff and rehearsal still require their own live evidence.
- #267: manual recapture evidence does not prove the scheduled run has occurred.
- #253 and #275: bounded checks do not replace the full capacity campaign. That campaign was not started.
- #136 and #151: final migration freeze and promotion remain launch-stage work.

The audit and recovery archive are at `/Users/marcus/Developer/card-keepr-worktrees/repo-audit-20260910/`. Local execution logs are at `/tmp/card-keepr-resume-20260910/`.

## Remaining hosted ingestion diagnosis

Full run [34431922408](https://github.com/KeeprDigital/card-keepr/actions/runs/34431922408) at `16237103` passed lint, checks/API, domain and all acceptance groups. Ingestion shard 1 completed with 257 passes and four timeouts; shard 3 completed with 262 passes and one obsolete no-change revision assertion. Shard 2 recorded two timing failures and stopped making progress before its job cap. This remains a failed run.

Focused hosted run [34432861414](https://github.com/KeeprDigital/card-keepr/actions/runs/34432861414) reproduced all six timing failures without the rest of the suite. Its host samples show ample available memory; these results do not support treating those six as random suite interference. The separate progress-stall selection is a distinct investigation.

The existing tests now separate independent locale orders and the absolute observation-count deltas of 24 and 25, with distinct case identities. Published predecessor fixtures move into scoped setup hooks, keeping real owner operations and verified SQL backup/import. The single-card reconfirmation test uses the existing single-card changed-source fixture; the 32-card fanout regression remains separate. The no-change caller test now requires the unchanged consumer revision and a distinct verified backup attempt. Deadlines, retries, CI configuration and the earlier testing baseline remain unchanged.

Local affected selections passed: four no-change/locale cases, five threshold/lookup/reconfirmation cases, and three lifecycle/history cases. Types and formatting passed. These targeted results do not replace hosted verification or certify the complete integration.

### Enforced fixture execution boundary

Focused hosted run [34433386083](https://github.com/KeeprDigital/card-keepr/actions/runs/34433386083) at `11c56b59` passed all 12 timing cases, but the separate progress selection still stalled in the complete identity-correction file. Narrowing individual test cases was therefore insufficient. Neither that focused run nor the complete integration was green.

The shared native fixture API now defaults to controlled execution of the actual production preparation, publication and backup functions. D1/R2 persistence and independent SQL export/import verification still run. Explicit `ThroughBinding` helpers bypass the controlled driver for tests that assert platform dispatch, interruption, races or recovery. Existing callers retain that boundary explicitly; five rule/persistence suites use controlled publication. No deadlines, retries, sharding, dependency versions or production scheduling change in this correction.

A behavioral contract exercises unchanged publication through both modes. It checks the same retained evidence, unchanged consumer revision and distinct verified backup attempt, and inspects actual Workflow instances: the default helpers must create zero reconciliation/backup instances, while the explicit binding helpers must create both. The guard reuses each test's existing introspection session and leaves disposal and storage reset intact. This makes an accidental reversal of the shared defaults observable in CI. It does not claim controlled execution proves platform scheduling.

The three-case guard file and typecheck pass locally. All six affected files pass together: 57 tests in 173.59 seconds on macOS. Lint and changed-file formatting pass. Both independent review axes found no remaining issues. Hosted validation remains required before integration can merge.

### Current toolchain disposition

The earlier `docs/reviews/toolchain-reconciliation-2026-09-09.md` records a historical proposed combination and its failed validation; its version table is not the current selection. Cleanup retains the already-green main `1998ab53` manifest: plugin 1.1.6, Vitest 4.1.11, Wrangler 4.130.0, direct acceptance Miniflare 4.20260730.0, Node types 26.5.0 and libsodium-wrappers 0.8.4. Plugin/Wrangler retain their upstream Miniflare 5.20260908.0-alpha and workerd 1.20260908.1 dependencies; direct acceptance uses workerd 1.20260730.1. These are distinct harness runtime versions, recorded explicitly rather than forced into one generation during cleanup.

The preserved six-file patch remains archived and is not reapplied over today's working baseline. The plugin migration and type setup are already present; the older proposal to move direct acceptance to Miniflare 5 and retain older Node/libsodium versions is superseded by the tested main manifest. Integration changes only the compatible fast-uri lock entry to 3.1.7. The production encryption/export/restore checks remain part of final validation of the retained runtime dependencies. A fresh 10 September audit reports zero production advisories and five high development dependency entries (`sharp`, `undici`, and their Miniflare/Wrangler/plugin parents); no forced major/alpha replacement is applied. Final complete integration and actual-main checks remain required.
