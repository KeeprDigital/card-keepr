# Publication #253 comparison evidence

11 September 2026. Read the [decision report](../../publication-253-comparison-20260911.md),
[measurement tables](measurements.md), and machine-readable [summary](summary.json).
This directory retains successful, failed and incomplete local observations.
It is not an issue-resolution or production-capacity certificate.

## Source boundary and environment

- Base commit: `fa0a404e4f980914a79825d6ff34f6d9f68e6a48`.
- [Starting state](starting-state.json) records the original dirty checkout and
  protected plan hashes. [Starting patch](starting-worktree.patch) captures its
  tracked diff except the unrelated private-launch plan.
- [Preservation verification](preservation-verification.json) confirms the
  original tracked diff and both unrelated plan files remain byte-identical,
  and each experimental patch applies to the base index.
- [Toolchain](toolchain.json): macOS 26.5.2, Apple M4, 16 GiB RAM, Node 26.8.2,
  pnpm 12.3.4, Vitest 4.1.11, Cloudflare Vitest plugin 1.1.6, its active
  Miniflare 5.20260908.0-alpha and workerd 1.20260908.1. Other installed versions
  are listed separately, not conflated with this active test runtime.
- Detached experiment worktree retained at
  `/tmp/card-keepr-publication-253-comparison-20260911`; it currently contains
  the grouped prototype. All heavy local runs were sequential. The normal
  original native test ran separately after both layout measurements.
- Issue snapshots include comments: [214](issue-214.json), [216](issue-216.json),
  [253](issue-253.json), [275](issue-275.json). No GitHub state was changed.

## Final measurements

| Run                              | Exact source snapshot                                                    | Result and retained files                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Singleton large pairs            | [Patch](single-experiment.patch), [hash](single-source.json)             | Two passed tests; [log](single-final.log.gz), [full→unchanged](single-final.json.unchanged.gz), [full→changed](single-final.json.changed.gz), [process](single-final-process.json)     |
| Singleton fault                  | [Patch](single-fault-experiment.patch), [hash](single-fault-source.json) | One passed test; [log](single-fault.log.gz), [measurements](single-fault.json), [process](single-fault-process.json)                                                                   |
| Grouped fault                    | [Patch](grouped-experiment.patch), [hash](grouped-source.json)           | One passed test; [log](grouped-fault.log.gz), [measurements](grouped-fault.json), [process](grouped-fault-process.json)                                                                |
| Grouped large pairs              | Same grouped patch                                                       | Two passed tests; [log](grouped-final.log.gz), [full→unchanged](grouped-final.json.unchanged.gz), [full→changed](grouped-final.json.changed.gz), [process](grouped-final-process.json) |
| Original native performance test | Unchanged primary diff                                                   | One passed test; [result](native-current-result.json), [log](native-current.log.gz), [callback evidence](native-current.json.gz)                                                       |

Each large-pair report has a matching `.catalogues.json.gz` file appended to its
original basename. These contain every normalized consumer record for both
acceptances, including lifecycle fields and relationships. The four completed
pair files are checked by [summarize.py](summarize.py): exact normalized content,
matching raw entity identity sets, 4,006 records, completed verification, four
actual SQL imports per layout, zero foreign-key errors, one changed factual Card
record and 2,001 additional lifecycle-only changes. The normalizer replaces
generated Card IDs with official identity aliases and revision IDs with stable
within-history labels; it does not drop other facts. Deterministic test UUIDs
give both layouts the same identities; raw identity sets are checked separately.

The reporter writes results even on test failure. SQL dump sizes/statements,
actual host SQLite imports and restore query rows are in `EXPERIMENT_SQL_EXPORT`,
`EXPERIMENT_SQL_IMPORT` and `EXPERIMENT_RESTORE_QUERY` log records. No SQL data,
credentials or production catalogue was used: this is the synthetic offline
fixture. The exact temporary SQL databases were disposed by the existing helper;
retained evidence records the imports and independently verified contents.

## Failed and incomplete attempts

All remain failures of the experiment version that produced them. None counts
as a final pass or is silently discarded from the measurement history.

| Artifact prefix                        | Outcome and disposition                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `single-setup-failure`                 | Instrumentation proxy failed the migrations helper's branded D1 check before the workload. Fixed by using the original raw environment for migrations only                                                                                                                                                                                                              |
| `single-inventory-failure`             | First full publication, real backup/restore and full consumer check completed; post-measurement census then hit `SQLITE_AUTH` reading an internal metadata table. Marked such tables unavailable and used returned database-size metadata; the whole test remained failed                                                                                               |
| `single-three-revision-failure`        | Full and unchanged checkpoints restored; third export failed in Miniflare whole-dump JSON serialization before import. Retained [diagnosis](../../publication-253-emulator-export-limit-20260911.md), [log](single-three-revision-failure.log.gz), [phases/inventory](single-three-revision-failure.json.gz) and two verified catalogues. Fresh pairs do not resolve it |
| `single-pair-registration-failure`     | Test registration passed an undefined context; workload did not execute. Fixed by registering ordinary independent tests                                                                                                                                                                                                                                                |
| `single-fault-ordering-oracle-failure` | Retry response had the same semantic data with different property order; naive JSON-string comparison failed. Changed only the oracle to existing canonical JSON comparison, retained this failure, reran the fault test successfully                                                                                                                                   |

These pilot artifacts precede the frozen final patches. Their log/measurement
outputs are retained; not every intermediate source state was separately
snapshotted. Do not attribute their timings to the final patch or claim exact
source reproduction for those intermediate failures. The final paired and fault
measurements above each have exact source snapshots.

## Reproduction

All three final patches are **complete diffs from the base commit**, containing
the relevant original optimization work plus the isolated test/instrumentation
changes. Do not apply them on top of the primary dirty checkout, each other,
or `starting-worktree.patch`. Create a fresh detached worktree per source snapshot.
For example, from the repository:

```sh
git worktree add --detach /tmp/publication-single-repro fa0a404e4f980914a79825d6ff34f6d9f68e6a48
git -C /tmp/publication-single-repro apply /Users/marcus/Developer/card-keepr/docs/reviews/evidence/publication-253-comparison-20260911/single-experiment.patch
cd /tmp/publication-single-repro
pnpm install --frozen-lockfile
PUBLICATION_EXPERIMENT_WORKTREE=/tmp/publication-single-repro \
PUBLICATION_EXPERIMENT_EVIDENCE=/tmp/publication-comparison-new-evidence \
python3 /Users/marcus/Developer/card-keepr/docs/reviews/evidence/publication-253-comparison-20260911/run-experiment.py single-final
```

The runner uses the production ingestion Vitest configuration and `stress` tier,
the isolated layout test and its retained reporter. It sets the evidence path,
samples descendant-process RSS once per second and has a finite 1,200-second
watchdog. Each two-acceptance test has an explicit 900-second bound; hook/disposal
limits remain finite. The original 120-second tests are untouched. Path inputs
and overwrite protection were made portable after measurement; the sampling
loop is retained. The RSS command is for the recorded macOS environment.

Repeat with a different worktree and `grouped-experiment.patch` for the grouped
case. To reproduce singleton fault evidence use `single-fault-experiment.patch`;
for grouped fault use the grouped patch. Pass
`apps/ingestion/test/publication-layout-fault-experiment.stress.spec.ts` as the
runner's second argument. Give each run a fresh output label. **Run heavy cases
sequentially**, including the native test. Do not overlay patches or silently
substitute a different toolchain when comparing results.

To recheck the retained outputs without running any database workload:

```sh
python3 docs/reviews/evidence/publication-253-comparison-20260911/summarize.py
python3 docs/reviews/evidence/publication-253-comparison-20260911/render-measurements.py
```

The summary reader accepts raw or gzip-compressed reports/logs. The generated
tables may be formatted again with the repository formatter. [manifest.json](manifest.json)
records byte lengths and SHA-256 for each retained file, plus uncompressed hashes
for gzip files. Its report hashes are separate from source snapshot hashes.

## Interpretation limits

The experiment changes public source ordering, cursor/group membership and one
group's work per callback as well as packaging; it does not isolate compression
alone. It renders through existing production functions and staging/read/backup
seams, rather than constructing a second in-memory publisher. The provider API
control plane and Workflow scheduling are controlled; actual D1/R2 and SQL
export/import are real. Host restore queries are measured separately.

Instrumentation changes D1 `first()` into the same SQL through `all()` to retain
returned metadata before selecting its first row. No extra query is issued,
and both layouts use the same wrapper. Migrations and observer-only census are
outside application totals. Timing has instrumentation overhead; rows/index
billing, active CPU, continuous isolate working set and provider charges remain
unmeasured. The phase timing/PUT outcome/HEAD-size caveats in the measurement
tables apply to all raw outputs.

The alternative enforces its raw-byte cap by rejecting oversize assembled groups;
it still needs deterministic splitting and large-record compatibility before
promotion. Stable insertion is an analytical membership probe from actual
groups, not a further published/restored scenario. The interruption test is a
controlled lost PUT response, not a live Workflow instance kill. These boundaries
are part of the result, not reasons to reinterpret old acceptance as passed.
