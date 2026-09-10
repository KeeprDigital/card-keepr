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

The targeted history selection passed six tests, the controlled-preparation comparison passed three scenarios, and the shared owner/source helper passed all three journeys. Two independent review axes found the history corrections and controlled semantic fixture boundary acceptable. Types, lint and catalogue boundaries passed locally before the controlled-driver change; its typecheck also passed. Final required checks on the complete resulting branch remain the merge gate, followed by checks on the actual main commit. The live PR checks are the authoritative final result.

The dependency audit found no production dependency advisories. A compatible `fast-uri` patch updates the lockfile from 3.1.4 to 3.1.7. Remaining development-tool advisories concern the installed Cloudflare/Miniflare dependency chain; the automated proposed major/alpha replacements are not applied as part of cleanup.

## Launch work intentionally left open

- #236 / draft #246: isolated dev setup has existing implementation, but the account/credential isolation choice and live first-install proof remain open. No resources or credentials were provisioned during cleanup.
- #237, #238, #239 and #240: staging, production, operational handoff and rehearsal still require their own live evidence.
- #267: manual recapture evidence does not prove the scheduled run has occurred.
- #253 and #275: bounded checks do not replace the full capacity campaign. That campaign was not started.
- #136 and #151: final migration freeze and promotion remain launch-stage work.

The audit and recovery archive are at `/Users/marcus/Developer/card-keepr-worktrees/repo-audit-20260910/`. Local execution logs are at `/tmp/card-keepr-resume-20260910/`.
