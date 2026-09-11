# Repository maintenance before development

The owner approved the six-part repository cleanup identified on 11 September:
establish the supported baseline, move maintained contracts out of prototypes,
clarify historical research, consolidate configuration, check operational
JavaScript, and measure narrower test-fixture reads.

## Baseline and scope

The maintenance branch preserves the four local tooling commits through
`8c4f1100` and merges upstream `d9ed6c9a`, without rewriting that work. The local
version manager now selects Node 26.8.2; the existing Corepack installation is
updated to 0.36.0 and its pnpm shim selects 12.3.4. A frozen install succeeds.
No dependency resolutions, deployed Worker settings or remote catalogue data change.

## Changes

- `contracts/` now owns OpenAPI, API/export/admin schemas, administration and
  serialization documents. Production and test imports follow the new location.
  Parsed schemas match the original files exactly, including schema identities.
  OpenAPI differs only in `info` metadata that now identifies it as maintained.
  Existing JSON lint and changed-file formatting now cover these maintained files.
  Prototype demonstrations and original proposals remain clearly historical.
- The five previously untracked tooling research/review notes are preserved,
  formatted and marked as historical, with links to current operating guidance.
- All ten repeated setup sequences across six workflows use the local
  `setup-toolchain` composite action. It retains the same action pins, source-store
  cache key, frozen installation on cache hits, native build policy and temporary
  Corepack installation. Job identities, concurrency, shards and release gates
  are unchanged. The release contract follows local actions when checking pins.
- The two Worker projects share `tsconfig.base.json`, with their existing file
  ownership and generated bindings. `tsconfig.tooling.json` adds strict Node-only
  compiler checking for six JavaScript utilities: config parsing, HTTP transport,
  development processes, formatting, D1 release queries and release-state SQL.
  JSON enters as `unknown`; existing validation narrows it before property access.
- Identity setup no longer hydrates candidate records when only the header is
  needed. Explicit record-kind selection skips unused partition bodies while
  preserving metadata pagination, integrity validation and all existing assertions.
  Full candidate and failed-candidate comparisons continue to read every partition.

## Validation

The pre-change performance selection passed all 101 tests with two concurrent
files and the existing deadlines. File times on this Mac were 140.886 seconds for
reconciliation progress, 121.464 seconds for card identity and 79.289 seconds for
identity corrections. These are elapsed samples, not CPU profiles or promises.

The same 101 tests passed after the change, with identical test names. File times
were 150.200 seconds for reconciliation progress, 116.466 seconds for card identity
and 88.123 seconds for identity corrections. This mixed single-sample result does
not establish a wall-clock speedup. The concrete optimization is fewer unused
partition-body requests and no record hydration for header-only fixture setup.

The complete non-test check passes, including lint, formatting, all six compiler
projects, generated output, catalogue boundaries/cycles and both Worker build dry
runs. Actionlint 1.7.12 passes all workflows. The six release workflow contracts
and nine focused release D1/state/formatter tests pass.

### Standards review

Independent read-only review of `bb6802f9...7439095b`: no documented-standard
breaches or actionable heuristic smells. It verified record-kind consumers,
complete failed-candidate comparisons, cache/release semantics and schema equality.

### Spec review

Independent read-only review of the same diff found one issue: the promoted
administration contract still gave the historical prototype authority, and
OpenAPI still called itself a discussion artifact. Those status statements are
corrected; schema identities and validation behavior remain unchanged. The Spec
reviewer verified the correction and reports no outstanding findings.

Full regression and hosted validation are in progress.

The implementation follows the existing testing strategy. Reference syntax was
checked against [GitHub composite actions](https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action)
and [TypeScript checkJs](https://www.typescriptlang.org/tsconfig/checkJs.html).
