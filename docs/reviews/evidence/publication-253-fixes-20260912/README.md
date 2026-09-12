# Publication testing implementation evidence

12 September 2026. See the [implementation and acceptance record](../../publication-253-implementation-20260912.md)
and the separate [layout comparison](../../publication-253-comparison-20260911.md).
This directory retains successful, failed and superseded attempts. Earlier
120-second failures are not reclassified. Measurements use emulators and local
SQLite, not production performance or billing.

## Source and preservation

- `starting-state.json` records the original `main` commit, starting patch hash
  and both unrelated planning-file hashes. `starting-worktree.patch` preserves
  the tracked work present at implementation start.
- `before-simplification.tar.gz` retains the six files before selected late
  optimizations were removed. `simplification-applied.patch` records that removal;
  its old-side paths include the temporary evidence extraction directory.
- `hosted-validation-source.patch` is the code/test/configuration snapshot
  committed as `8a48b5f95e476432fcdd45c1dc6b3d2d272f67e4`, based on
  `fa0a404e4f980914a79825d6ff34f6d9f68e6a48`. All 53 changed files were compared
  byte for byte with the final working copy. The isolated validation branch is
  `codex/publication-253-validation-20260912`; the owner's checkout remains
  uncommitted on `main`.
- `final-state.json` records those source hashes and preservation checks.
  `final-documentation.patch` captures the changed tracked documentation;
  the implementation report and this index are separate new files.
- `manifest.json` records every evidence file's SHA-256 and byte length,
  excluding itself. Gzip entries also record the decompressed hash and size.
  JSON reports and the hosted full log are compressed without altering their
  original contents. Do not run formatters over retained machine evidence.

## Final checks

| Evidence | Outcome |
| --- | --- |
| `frozen-install.log`, `check-final.log` | Frozen install and all lint/format/type/generated/boundary/build checks passed |
| `routine-full.log` | 1,559 routine tests passed across domain, API, ingestion and acceptance |
| `full-stress.log`, `full-stress.json.gz` | Full local selection: ten files, 20 tests passed |
| `backup-transport-regressions-final.log` | Five snapshot/parser/upload/import boundary tests passed |
| `caller-retirement.log`, `caller-retirement.json.gz` | All five shared transport/binding caller tests passed after the complete persistence patch |
| `hosted-focused/`, `hosted-focused-run.json` | 33 tests passed; run 34675388868 |
| `hosted-ci/`, `hosted-ci-run.json` | All nine CI jobs passed; run 34675532753; ingestion artifacts contain all 794 tests |
| `hosted-bounded/`, `hosted-bounded-run.json` | Both bounded tests passed; run 34675535411 |
| `hosted-full/`, `hosted-full-run.json`, `hosted-full.log.gz` | Full selection: ten files, 20 tests passed; run 34675534158 |
| `final-documentation-check.log` | Final report/document formatting and whitespace checks |

Every hosted run identifies the same snapshot commit in its retained run metadata.
The full hosted log records Ubuntu 24.04.5, runner image `20260907.300.1`, Node
26.8.2 and pnpm 12.3.4. The project pins Vitest 4.1.11 and Cloudflare test plugin
1.1.6. The earlier comparison's toolchain file records the same local macOS host.
Heavy local runs were sequential; hosted jobs used separate GitHub runners.

The native assertion measured 7,736 ms locally and 14,277 ms hosted against its
unchanged 15,000 ms bound. Both passed, but the hosted sample has little margin.
The Product publication measurement was 78,015/110,850 ms, with real backup and
restore included. Passing these samples does not certify future timing or
maximum production capacity.

## Retained-history and export-boundary proofs

`retained-history.log` and `retained-history.json.gz` contain the sequential
full → unchanged → changed run. Every acceptance produced an actual SQL backup,
executed its restore and verified all 4,006 consumer records. The third SQL file
was 643,453,399 bytes; the final emulator database was 824,287,232 bytes. The
test completed in 378.622 seconds under its own 900-second bound. Its subsequent
storage census is outside the per-acceptance timing and is not production work.
This run has no request instrumentation; use the earlier comparison for that.

`history-validation.patch` preserves the tracked source/configuration used by
that isolated experiment relative to the base commit. Its untracked
`sqlite-transfer.ts` and pinned plugin patch are retained in the hosted source
snapshot. `history-validation.spec.ts.txt` retains the isolated test; it was
removed from the shipping selection before hosted validation. To reconstruct,
use a disposable checkout at the base, apply the history patch, copy those two
new files from the validation snapshot, and place the test in
`apps/ingestion/test/publication-history-validation.stress.spec.ts`. Install the
frozen lockfile and select that file through `test:stress:full`. The retained
test and patch include the changed-record fixture; do not substitute a smaller
workload or skip restore. Keep this heavy experiment separate from other local
measurements.

`export-boundary-native-snapshot.log` proves the old Miniflare export fails with
`Invalid string length` on the same 260 × 1 MiB payload that the replacement
successfully snapshots, streams and imports. The actual SQL file is 545,269,208
bytes. The two `*export-reproduction.mjs.txt` files retain the diagnostic sources;
their imports reference the recorded local checkout and must be adjusted if
reproducing elsewhere. Run them with the pinned Node runtime, separately from
other heavy tests. The successful boundary script uses the plugin's actual
Miniflare dependency rather than the distinct direct root dependency.

## Failed and superseded attempts

- `export-repro-toolchain-setup-failure.log`: initial dependency lookup selected
  the wrong Miniflare API. The corrected diagnostic uses the plugin dependency.
- `export-boundary-red.log`, `import-stream-red.log`: the old giant-string
  export failure and old non-streaming import incompatibility remain recorded.
- `import-stream-green.log`, `import-stream-hermetic.log`,
  `import-stream-after-diagnosis.log`, `node-backup-delay-diagnostic.log`:
  initial asynchronous Node snapshot implementation passed small correctness
  checks but had repeated 30/8-second delays; it was replaced.
- `export-boundary-comparison.log`, `export-boundary-diagnostic.log`,
  `snapshot-journal-diagnostic.log`: investigation of the incomplete SQL dump
  from a separately modified WAL snapshot. The native snapshot implementation
  and completion-trailer check supersede it; actual restore rejected the bad dump.
- `import-stream-native-snapshot.log` and `backup-transport-regressions.log`:
  successful intermediate targeted checks, superseded by the final five-test run.
- `backup-focused-first.log`: invalid asynchronous pool configuration;
  `backup-focused-second.log`: 13 passing backup tests, insufficient on their
  own to validate the shared provider path.
- `publication-focused.log`, `publication-focused.json.gz`: 53 passing tests
  and five caller tests, three of which failed with the partial persistence-path
  patch. Corrected caller evidence retains all five passing cases separately.
- `check.log`: initial full check stopped at formatting previously sealed raw
  evidence JSON. `.prettierignore` now preserves evidence bytes; no sealed old
  JSON was reformatted. `check-final.log` records the complete successful check.

Routine injected-failure and runtime teardown diagnostics remain in the raw logs.
No new suppression or automatic retry was added to make them disappear. A final
framework pass does not erase any earlier failure or prove all production failure
modes. Issue #253 remains open for review/merge and explicit reconciliation of
its acceptance; #275's usable 5/50 GiB capacity remains outside this proof.
