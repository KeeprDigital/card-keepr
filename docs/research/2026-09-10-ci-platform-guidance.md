# Testing and CI review

Investigated 10 September 2026 using the local suite, GitHub run/job APIs, repository
rules APIs, and current first-party platform guidance. This is a recommendation,
not a claim that a new hosted CI configuration has been benchmarked. The previous
cleanup remains uncommitted; historical hosted runs do not contain those changes.
The investigation itself changed documentation only. The subsequently authorized
implementation is recorded in the testing guide: main protection is enabled,
small publisher tests use the local runtime, mixed-game recovery replaces the
five-game fixture, and benchmarks have a separate explicit selector. Findings
below describe the pre-implementation snapshot unless stated otherwise.

## Decision

Keep the fast default and sharded full regression policy. The extended tier is a
holding area for several different concerns, not eleven essential extra gates.
Preserve meaningful publisher and recovery assertions, simplify their long
journeys, and keep capacity/profiling experiments manual. Establish reliable,
enforced green CI before adding runners, matrices, or more scheduled suites.

The immediate priority is merge enforcement: the workflow runs full checks for
ready PRs, but **main currently has no branch protection or applicable rules**.
On this inspection, the branch-protection API returned `Branch not protected`,
the repository rulesets API returned `[]`, and the effective main rules API
returned `[]`. The separate exact-commit Production Release guard does not prevent
merging failing code. Sources: [branch protection API](https://api.github.com/repos/KeeprDigital/card-keepr/branches/main/protection),
[rulesets API](https://api.github.com/repos/KeeprDigital/card-keepr/rulesets),
[effective main rules API](https://api.github.com/repos/KeeprDigital/card-keepr/rules/branches/main),
[release workflow](../../.github/workflows/production-release.yml).

## What the extended tests are and whether to keep them

The selector currently lists eleven files. They are not all full real-world
catalogue loads: several publisher journeys use very small synthetic fixtures.
“Complete” in those test names refers to the fixture's declared source coverage.
This corrects the earlier overly broad description of the tier.

| Files | Additional proof | Recommendation |
| --- | --- | --- |
| [One Piece](../../acceptance/one-piece-catalogue.test.mjs), [Digimon](../../acceptance/digimon-catalogue.test.mjs), [Fusion World](../../acceptance/fusion-world-catalogue.test.mjs), [Gundam](../../acceptance/gundam-catalogue.test.mjs) | Publisher-specific discovery, rejection cases, publication, consumer data and regional/alternate identity through real process boundaries. The positive fixtures assert only 2, 1, 2 and 1 cards respectively. | Keep the assertions. These are candidates for compact routine integration tests, not permanent capacity tests. Separate redundant negative cases already proven lower down; reduce repeated Wrangler startup and partition reads; return bounded, reliable cases to full CI once measured. Do not delete them solely because they were moved to extended. |
| [composed-recovery](../../acceptance/composed-recovery.test.mjs) | Two long scenarios: recovery and fresh baseline, with multiple publications, admissions, identity corrections, backup failure/retry, restored consumer state and fencing. | Keep these invariants, but replace the monolithic repetition with focused Worker cases plus a compact real recovery journey. It is over 1,100 lines and repeats substantial setup between its two scenarios. |
| [five-game-recovery](../../acceptance/mixed-game-recovery.test.mjs) | Five-game composition, unchanged sibling components, current-plus-two revision retention, and actual SQL import. | Keep one bounded mixed-game restore/retention proof. Consolidate overlap with composed recovery and existing SQL-restore tests. Its 6 GiB preflight uses the Riftbound-derived helper; the code does not provide an independent measurement justifying the same floor for this synthetic fixture. Measure it, then give it a justified budget. |
| [one-piece-two-source](../../acceptance/one-piece-two-source.test.mjs) | Retained P-001 Bandai evidence replay across multiple game/source publications. | Keep as an explicit retained-data integration investigation. Extract any genuinely unique cross-source correctness assertion into small routine coverage. Do not require the entire replay on every PR. |
| [riftbound-catalogue](../../acceptance/riftbound-catalogue.test.mjs) | Large retained inventory, Errata and Product replay through review, publication and real SQL restore. | Manual investigation only. Its historical ~21-minute / 3.94 GB local occupancy cost is disproportionate for routine regression. The scenario injects 1,183 missing-image responses and explicitly makes no full-image or production-capacity claim. Keep the two-record restore as normal proof. |
| [native-sqlite-export](../../acceptance/native-sqlite-export.test.mjs) | Regression beyond the old 64 MiB stdout buffering ceiling. | Keep as a targeted export-helper regression, run when that helper changes. It intentionally generates 65 MiB of evidence; the exact large boundary is its purpose, so shrinking it below that limit would destroy the proof. |
| [native-isolate-metrics](../../acceptance/native-isolate-metrics.test.mjs) | Verifies heap/CPU profiling and allocation capture above the profiler's 64 MiB trigger. | Keep with the profiling tools as an explicit calibration test. It tests the measurement system, not ordinary application behavior. |
| [reconciliation-capacity-probe](../../acceptance/reconciliation-capacity-probe.test.mjs) | Synthetic 1,001-Product memory experiment with external profiling reports. | Treat as a benchmark command, not ordinary regression. It currently skips unless an environment flag is supplied, requires an output prefix, and retains state after failure. A green extended run therefore does not mean this experiment ran. |

The retained Riot measurements are recorded in
[issue-233-capacity.md](../validation/issue-233-capacity.md). The routine suite
already retains [two-record native publication and restore](../../acceptance/riftbound-bounded-intake.test.mjs),
[real SQL import with consumer/provenance verification](../../acceptance/backup-sql-restore.test.mjs),
[Product publication across game boundaries](../../acceptance/product-catalogue.test.mjs),
and [Worker backup/recovery fault coverage](../../apps/ingestion/test/backup-recovery.spec.ts).
These establish overlap; they do not establish that every assertion in the
extended files can be deleted without replacement.

The nine-file `test:stress` Worker suite is separate from these eleven extended
acceptance files. It contains pacing, request/discovery capacity, large evidence,
images and reconciliation workloads. Neither suite should silently become a
mandatory pre-merge or per-release capacity exercise.

## What actual CI runs show

The ten most recent main-branch `ci` runs at inspection time contained nine
failures and one cancellation, spanning 6–8 September. No clean hosted baseline
exists in this sample. [Main CI history](https://github.com/KeeprDigital/card-keepr/actions/workflows/ci.yml?query=branch%3Amain)

The latest main run, on the checkout's base commit `51e1c83f`, took 20m21s overall.
Step durations from its jobs API:

| Work | Observed duration/result |
| --- | --- |
| Restore installed dependencies | 2–3 seconds per job; installation was skipped on cache hits |
| Lint job | 14 seconds, passed |
| Domain job | 20 seconds, passed |
| Checks job including types/build/API | 51 seconds, passed |
| Ingestion test steps | 397s and 469s failed; third cancelled after 718s |
| Acceptance test steps | 206s and 1,010s failed; third cancelled after 1,205s |

Sources: [main run](https://github.com/KeeprDigital/card-keepr/actions/runs/34223371172),
[job API](https://api.github.com/repos/KeeprDigital/card-keepr/actions/runs/34223371172/jobs).
Its acceptance failures included composed recovery, Digimon, Fusion World and
the retained Bandai journey. Moving them out of routine CI reduces its workload;
it does not repair those scenarios or establish that their failures were all
caused by resource contention.

A busy-period PR run lasted 42m07s, with some jobs starting almost six minutes
after dispatch. Queue time as well as test execution mattered. That branch had
its own configuration changes, so it is evidence of contention, not a benchmark
of our local setup. [PR run](https://github.com/KeeprDigital/card-keepr/actions/runs/34349778604)

The 7 September scheduled stress run exited with `No test files found` in the
empty API stress selection. The local cleanup fixes that runner selection.
The 9 September manually dispatched stress run did reach tests and failed after
562 seconds of execution. The scheduled suite is not yet a proven green safety
net. Sources: [scheduled run](https://github.com/KeeprDigital/card-keepr/actions/runs/34100293889),
[manual run](https://github.com/KeeprDigital/card-keepr/actions/runs/34336061374).

Local post-cleanup results are 42s for quick checks and 3m39s for 334 routine
acceptance tests. Unsharded ingestion measured 10m19s; its five date-related
failures were corrected and the affected 23-test file passed separately.
These measurements are from macOS/Node 26, not Linux/Node 22 CI. See
[testing policy and measurements](../testing.md).

## Recommended CI for this project

| Trigger | Work |
| --- | --- |
| Draft PR changes | Existing lint, checks, and domain/smoke jobs; cancel superseded runs |
| Ready PR or transition to ready | All static/domain/API checks, three ingestion shards, three routine acceptance shards |
| Merge/push to main | Same full checks on the actual resulting commit; retain exact-commit release evidence |
| Manual CI dispatch | Full routine verification; give manual runs a separate concurrency group so they cannot cancel a push-main run |
| Weekly background checks | Retained-source freshness and a deliberately bounded, validated stress selection; establish a green baseline before relying on it |
| Capacity/profiling investigations | Explicit named scenario on demand, with measured resource limits and temporary-state cleanup; no all-scenario default requirement |

Keep the current nine-job topology initially. With cache restoration taking only
seconds, merging jobs or redesigning caches is not the main opportunity. Preserve
one Linux/Node 22 environment, two files per runtime runner and three shards per
large suite. Preserve storage isolation. Adding more OS/Node matrices or bigger
machines is not justified by current evidence.

Concrete next changes, in priority order:

1. Configure main to require the existing nine checks: `lint`, `checks`,
   `domain-tests`, `ingestion-tests (1)` through `(3)`, and `acceptance (1)` through
   `(3)`. Require PRs and current-main integration; review explicit owner bypass
   policy. Keep the Production Release exact-SHA guard as well. No extra
   aggregate check is needed merely to rename these jobs.
2. Obtain clean hosted runs of the local cleanup and fix remaining failures.
   Aim for quick feedback within roughly 1–2 minutes of a runner starting and a
   normal full critical path under five minutes after setup. These are targets,
   not measured guarantees. Keep the existing 5/12-minute caps while diagnosing
   overruns rather than increasing them.
3. Remove the redundant cache-warming workflow after confirming main CI fills
   its cache, and stop repeating acceptance smoke in the draft-feedback job on
   full runs where acceptance already includes it. Retain direct smoke coverage
   on drafts. Both are small savings; they do not solve the large-suite issues.
4. Keep the fast installed-dependency cache for now, but include installation
   configuration/runtime identity in its key and retain a clean-install check
   after dependency changes. Compare npm-cache plus clean installation only if
   simplifying maintenance is worth its measured time cost.
5. Keep collecting all shard failures during cleanup (`fail-fast: false`). Once
   stable, consider fail-fast on PR matrices if avoiding wasted runs is more
   useful than reporting independent failures together. Balance shards using
   successful per-file duration data before adding more shards. Measure queue
   time, slowest shard and total runner minutes separately.
6. Simplify and requalify the small publisher/recovery tests above. Put purely
   diagnostic probes in an explicitly named benchmark area. Keep a short failure
   report from routine CI; do not upload multi-gigabyte fixture state by default.

Do not introduce broad path skips now: documentation contains testable contracts,
and source, schema, migrations and helpers are shared across layers. Do not add a
merge queue for its own sake; if one is adopted, configure `merge_group` and its
required checks together. Platform reasons and sources follow below.

This CI work must preserve [ADR 0016](../adr/0016-stage-software-separately-from-catalogue-publication.md):
software staging and Catalogue publication are separate. The current release
workflow is not the complete future staging/promotion design; adding giant
catalogue tests to ordinary CI would not supply isolated staging validation.

## Platform reference

### Required checks and events

GitHub treats successful, skipped and neutral check conclusions as satisfying required status checks. Conditional job skips report success, while skipping an entire workflow through path/branch filters leaves its required checks pending. A dependent required job must use `always()` and inspect its dependencies if upstream failure should fail the gate. Merge queues require the additional `merge_group` trigger. [GitHub required-check behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

Recommendations:

- Enable actual main-branch merge enforcement; workflow comments and the separate Production Release gate do not provide it. The parent review verified no branch protection or rulesets on 10 September.
- Require existing full check names initially. An aggregate gate becomes worthwhile if selective jobs or matrix changes make that list difficult to maintain; adding one is not necessary merely to rename the present checks. If introduced, explicitly verify required results and do not treat a skipped integration job as full regression evidence.
- Avoid workflow-level path filters on required CI for now. This project has document/schema contract tests and shared ingestion/domain/migration dependencies, so a broad “documentation only” skip is not automatically safe.
- Retain `ready_for_review` and `converted_to_draft` in addition to opened/synchronize/reopened. GitHub's default PR activities omit those transitions. [PR event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
- Add `merge_group` when enabling a merge queue, not as a substitute for enabling one. Until then, up-to-date branch requirements provide a straightforward policy for checking integration with current main.

### Dependency installation and cache

`setup-node` supports caching npm's package data, keyed by the lockfile; it does not cache `node_modules`. Its documented npm recipe still runs `npm ci`. [setup-node](https://github.com/actions/setup-node#caching-global-packages-data) `npm ci` rejects manifest/lockfile disagreement, removes existing `node_modules`, and does not rewrite either manifest or lockfile. [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)

The simple recommended baseline is npm package caching plus an unconditional clean install. This is a reproducibility and maintenance recommendation, not a claim that it is faster than this repository's existing exact-key `node_modules` cache.

If restoring installed dependencies proves materially faster, retaining that optimization is reasonable. Include the manifest, installation configuration, OS, architecture and relevant tool versions in its cache identity, and keep a clean-install validation path. The current key includes OS, Node major and lockfile only, and skips the clean-install check on a hit. Do not restore `node_modules` immediately before an unconditional `npm ci`, which deletes that restored tree.

GitHub makes default-branch caches available to PRs, while PR merge-ref caches cannot populate the base branch. Caches are immutable and evicted after seven days without access; multiple workflows can reuse a same-branch cache. [Cache reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

Consequently, `cache-warm.yml` is probably unnecessary: main CI now installs and saves the same dependency cache. Its assertion that nothing else runs on main is stale. Remove the extra workflow unless measurements demonstrate that having a setup-only job save before failing test jobs provides a useful benefit.

### Parallelism, isolation and cancellation

Each standard GitHub-hosted job receives a fresh runner. Public Linux standard runners currently provide four CPUs and 16 GB RAM; private-repository Linux specifications differ. [Runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) Separate shards therefore spread memory use across machines; local worker limits still control each machine's consumption.

Matrix `max-parallel` limits simultaneous jobs, while `fail-fast` cancels sibling matrix jobs following failure. [Matrix behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations) Keep `fail-fast: false` during cleanup to obtain all failures in one run. Reconsider it only when failures are rare and wasted runner time matters more than a complete failure report. Sharding can reduce elapsed time while increasing setup work; compare both critical-path duration and summed runner minutes.

Cloudflare's current Vitest plugin isolates storage by test file. Sharing storage requires both serial execution and disabled isolation; this changes correctness semantics. [Cloudflare isolation](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/) Do not disable isolation as an unmeasured speed shortcut. Reduce fixtures or move pure assertions out of Workers first.

Keep cancellation for superseded PR runs. GitHub concurrency groups can cancel running work and should distinguish workflows/events where cancellation is unwanted. [Concurrency controls](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) The current ref-based key also lets a manual main run and a push-main run cancel one another. Give explicit diagnostic runs their own group if they must finish. Cancelling superseded main runs is suitable only when checking/deploying the newest passing main state is intended; an intermediate cancelled SHA cannot supply complete exact-commit release evidence.

### Measurements needed before further optimization

Compare warm and cold dependency setup, each shard's execution time, total runner minutes, cancellations and timeouts across successful post-cleanup runs. Then rebalance the slowest shard before adding more jobs. Preserve current hard deadlines while fixing hangs; use those failures to identify unnecessary setup or leaked runtime processes rather than raising timeouts. None of these recommendations requires running the extended multi-gigabyte suite in ordinary PR CI.
