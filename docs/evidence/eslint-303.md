# Issue #303: typed ESLint and Prettier evaluation

**Recommendation: migrate to ESLint + Prettier in a separate, scoped follow-up.**
Compiler-backed lint demonstrably catches discarded D1/R2 operations that the
current Biome configuration, and the tested additional Biome promise rules,
miss. That is material prevention for this application's storage workflows.
TS7 can remain the compiler. A roughly 20-second uncached lint pass is a
reasonable development cost; adopting every strict-preset diagnostic is not.
Start with the demonstrated correctness rules below, review existing reports,
and introduce unsafe-data checks at annotated boundaries. The working checkout
retains Biome, TS7, its dependencies, commands and CI.

This is an evaluation, **not a merge-ready migration**. The broad reviewed
candidate still reports 2,510 findings. Its complete cleanup, actual editor
integration and Linux/full ready-PR CI have not been demonstrated. Migration
must satisfy those requirements with the chosen rules before replacing the
baseline. If that focused gate cannot stay useful, retain Biome rather than
turning off error checks indiscriminately.

## Reproduction and environment

Baseline: `479e15c51c0d58ef19e013742847fbef3e1572e5`, main on 10 September 2026.
The experiment used a detached disposable worktree, macOS 26.5.2 ARM64, Apple
M4, 16 GiB RAM, Node **26.8.2**, Corepack **0.36.0**, pnpm **12.3.4**. Explicit
PATH selection used already-installed copies; the interactive shell otherwise
has Node 26.3.0/Corepack 0.35.0. Measurements below use the pinned versions.

The [trial patch](eslint-303/trial.patch) contains the exact candidate manifest,
lockfile, ESM flat config, Prettier config/ignore file, four supplemental lint
projects, faulty/valid probes and reproduction runners. It only applies in an
isolated checkout of the baseline. It does not activate tooling in this checkout.

With the pinned runtime and Corepack already selected:

```sh
git worktree add --detach /tmp/card-keepr-303-replay 479e15c51c0d58ef19e013742847fbef3e1572e5
cd /tmp/card-keepr-303-replay
node --version
corepack --version
pnpm --version
pnpm install --frozen-lockfile
pnpm exec biome lint . --reporter=json
pnpm run typecheck
# Replace /path/to/card-keepr with the checkout containing this evidence.
git apply /path/to/card-keepr/docs/evidence/eslint-303/trial.patch
pnpm install --frozen-lockfile
pnpm exec tsc --version
pnpm exec tsc6 --version
ESLINT_TRIAL_RAW=1 node lint-trial/scan.mjs scan
node lint-trial/scan.mjs scan
node lint-trial/scan.mjs time
node lint-trial/probes.mjs
node lint-trial/editor-format.mjs
node lint-trial/format-policy.mjs
node lint-trial/validate.mjs
```

Scans write evidence to `lint-trial/results`; the runner exit does not mean
lint is clean. The measured ESLint CLI exits **1** for existing findings.
`probes.mjs` asserts diagnostic behavior without importing or executing faulty
files. `validate.mjs` temporarily moves the experiment files outside the tree,
retains candidate dependencies, runs the original checks/tests, and restores
those files even after a failed command. Never run the probes as application
code. No deployment or live publisher recapture is part of these commands.

### Exact dependencies and installation cost

[Registry metadata](eslint-303/registry.json) records versions, peers and
engines checked at trial start; the patch pins every new direct dependency.

| Package                                         | Candidate version                 |
| ----------------------------------------------- | --------------------------------- |
| ESLint / `@eslint/js`                           | 10.10.0 / 10.0.1                  |
| `typescript-eslint`                             | 8.70.0                            |
| `typescript` alias to `@typescript/typescript6` | 6.0.2 package; **6.0.3 API/tsc6** |
| `@typescript/native` alias to `typescript`      | 7.0.2                             |
| Prettier / `eslint-config-prettier`             | 3.9.6 / 10.1.8                    |
| SonarJS / Unicorn / Regexp                      | 4.2.0 / 74.0.0 / 3.3.0            |
| import-x / TypeScript import resolver           | 4.17.1 / 4.4.5                    |
| Vitest ESLint plugin / Node plugin              | 1.6.27 / 18.3.0                   |
| `@eslint/json` / globals                        | 2.1.0 / 17.12.0                   |

The compatibility package's published version and embedded compiler version
are different; [actual resolution](eslint-303/compiler-resolution.json) verifies
both ESLint's parser and the project resolve its **same TS6 API**. `tsc` still
runs TS7. This is Microsoft's documented coexistence arrangement, within
typescript-eslint's `>=4.8.4 <6.1.0` API range; no unsupported-version or peer
error was suppressed. [Microsoft guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0),
[typescript-eslint support](https://typescript-eslint.io/users/dependency-versions/).

The lock contains **189 additional package/version entries**, rising from 248
to 437, including optional platform packages, not 189 loaded modules. No prior
package/version entry disappears. Application dependencies and both existing
Cloudflare/Vitest/Miniflare/workerd arrangements remain pinned as before.
Vite additionally resolves its optional YAML 2.9.0 peer after installation;
existing runtime package versions are unchanged. See
[dependency delta](eslint-303/dependency-delta.json).

Strict peer and native-build validation remain enabled. Installation initially
stopped on **unrs-resolver 1.12.2**, pulled in by the TypeScript import resolver.
Its inspected hook delegates to `napi-postinstall` to locate/check its platform
binding, with an npm/download fallback if that optional binding is missing.
The trial explicitly approved that one hook; the pnpm-installed ARM64 binding
was present and the frozen install completed without fallback. Existing
esbuild/workerd approvals, disabled side-effects cache, scoped entities override,
runtime and package-manager ownership were retained. This extra native setup
is an adoption cost, not a bypass of the build guard.

The successful candidate frozen install after dependency resolution reported
0.9 seconds; replaying the saved patch with fresh dependency links in a second
worktree took 5.3 seconds. Both used the existing local package store, so cold
network installation cost remains unverified. Execution measurements below
exclude installation. The second checkout passed the diagnostic corpus and
formatter policy; its final scope correction reproduced the same 2,510 real-code
diagnostic identities (normalizing temporary root paths).

## File and type coverage

The [identical target list](eslint-303/files.json) contains 860 maintained files:
597 `.ts`, 7 `.mts`, 188 `.mjs`, 65 JSON and 3 JSONC. Generated Worker declarations,
generated Ajv output, prototype and retained acceptance fixtures are excluded
from lint; generated declarations are still loaded as type inputs.

ESLint analyzed all 860 with **zero parser failures**. Biome analyzed 859; the
1,324,849-byte `docs/validation/issue-233-measurements/issue-233-methods-1001-structured.json`
exceeds its default 1 MiB limit and produces a warning. This is an evidence JSON
coverage difference, not missing application code. Baseline lint exits 0 with
35 warnings and 22 informational findings. The three additional Biome rules
produce the same real-code findings.

[Coverage by file](eslint-303/coverage.json) records effective project ownership
and promise/Vitest rule activation for all **792 code/declaration files**:

| Ownership                                         |    Files | Type environment                                                                            |
| ------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------- |
| Shared source/support                             |      377 | Explicit lint project extending ingestion; real generated Worker types; `allowJs`           |
| Node scripts/configs/domain/acceptance            |      219 | Explicit Node lint project; `allowJs`; Worker declarations for imported shared domain types |
| Ingestion tests / source                          | 156 / 14 | Existing respective compiler projects                                                       |
| API source/tests and API support entry            |       20 | Supplemental project extending API test config and its Worker declarations                  |
| Six `.mjs` implementations with adjacent `.d.mts` |        6 | Explicit implementation-only file ownership                                                 |

Simply using `projectService: true` would not establish shared-source ownership:
there is no ancestor tsconfig. The initial explicit shared project also exposed
six parser failures because matching declarations displaced `.mjs`
implementations; the separate implementation project resolves them. Ordinary
compiler projects were never changed. [Parser project rules](https://typescript-eslint.io/packages/parser/#project),
[typed lint troubleshooting](https://typescript-eslint.io/troubleshooting/typed-linting/#traditional-project-issues).

Vitest rules apply to 171 actual test files, including domain `.test.mjs`.
Node acceptance tests and `test/support/fake-publisher/sqlite-restore.test.ts`
remain separate. Node rules apply to Node-executed files, not Worker source;
Workers retain `nodejs_compat` and their generated declarations. Explicitly switching off Worker-only globals in Node blocks is necessary
because ESLint merges globals. A [runtime-global probe](eslint-303/runtime-globals.json)
rejects `self` in a CLI file while accepting Node `process` and Worker `self`.
Node's API availability checks cannot establish Workers compatibility.
[Cloudflare Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

All 188 maintained `.mjs` files get inferred typed promise checks. Unsafe-flow
rules are disabled specifically for `.mjs`: unannotated inputs make them too
noisy to use yet. An additional TS6 `checkJs` run produced **3,995 real-code
diagnostics** (442 CLI, 455 scripts, 2,199 acceptance, 899 test/support; three
additional faulty-probe diagnostics excluded). Extend JSDoc or TypeScript
coverage first at `cli/lib/http-client.mjs`, CLI command inputs and release
provider/state interfaces. File inclusion does not imply those inputs are safe.

## Detection evidence and limits

The [probe results](eslint-303/probes-eslint.json) retain file, line, rule and
message. The runner verifies 26 invalid-case rule expectations plus valid
controls. These demonstrate prevention, not existing production defects.

| Deliberate mistake                                                                   | Baseline Biome | Biome + three typed rules | Candidate ESLint                  |
| ------------------------------------------------------------------------------------ | -------------- | ------------------------- | --------------------------------- |
| Discard local/imported Promise                                                       | Miss           | Detect                    | Detect                            |
| Discard actual D1 write / R2 put/delete                                              | Miss           | Miss                      | Detect                            |
| Bare `void` on an R2 write                                                           | Miss           | Miss                      | Detect                            |
| Async callback to synchronous `forEach`                                              | Miss           | Detect                    | Detect                            |
| Actual R2 Promise used as condition                                                  | Miss           | Miss                      | Detect                            |
| Await a number                                                                       | Miss           | Miss                      | Detect; typed + Unicorn duplicate |
| Omitted union state with a fallback return                                           | Miss           | Detect                    | Detect                            |
| Unsafe JSON assignment/member/return                                                 | Miss           | Miss                      | Detect                            |
| Redundant nullable check on a string                                                 | Miss           | Miss                      | Detect                            |
| Return unawaited operation inside `try/catch`                                        | Miss           | Miss                      | Detect                            |
| Floating Vitest async assertion / missing matcher                                    | Miss           | Miss                      | Detect                            |
| Floating Node `assert.rejects` / imported `readFile`                                 | Miss           | Miss                      | Detect                            |
| Focused test                                                                         | Warn           | Warn                      | Error                             |
| Duplicate JSON / JSONC keys                                                          | Detect         | Detect                    | Detect                            |
| Ignored string transform / GET fetch body / impossible regex / missing `.mjs` import | Miss           | Miss                      | Detect                            |

Correctly awaited D1/R2 writes, returned promises, awaited `Promise.all`, narrowed
JSON, exhaustive switches, and `ctx.waitUntil(operation.catch(handler))` pass.
Awaited, returned and combined Vitest assertions and its optional diagnostic
message pass. Bare `void` is deliberately disallowed; it neither handles
rejection nor provides a Worker lifetime.
[Promise rule options](https://typescript-eslint.io/rules/no-floating-promises/#ignorevoid).

Known gaps/overlaps: `await expect(1).resolves.toBe(1)` is not reported by any
configuration; ESLint's matcher checks do not prove the input is a Promise.
The unawaited Vitest assertion produces two reports. TypeScript itself catches
the simple always-truthy Promise condition, but accepts discarded storage calls;
the [TS7 probe check](eslint-303/probe-types.json) records the exact command and
its sole TS2801 diagnostic.
This corpus is not an accuracy benchmark over all possible defects.

### Real code, exceptions and triage

The unadjusted comparison reports **21,048 diagnostics**. The reviewed
candidate reports **2,510**: 2,507 errors and 3 warnings. The
[complete candidate finding inventory](eslint-303/findings.json) records each
file, line, rule, severity and triage category; [summary](eslint-303/summary.json)
contains every raw/candidate rule count. Categories are a rule-family screen
with explicitly inspected cases, **not 2,510 verified defects**. A full
occurrence-by-occurrence cleanup was intentionally not performed.

The main reviewed exceptions were:

- Permit guarded non-null assertions, matching the documented Biome policy;
  permit numeric/boolean interpolation; drop confusing-void style enforcement.
- Disable five unsafe-flow rules and coercion restrictions on unannotated
  `.mjs`, while retaining inferred promise, await and misuse checks.
- Allow Vitest's real second `expect` argument; drop conditional/helper-assertion
  preferences and async-stub `require-await` within actual Vitest test files.
- Exempt only the `test` function declared by **`node:test`** from floating
  registration reports. Assertions within its body remain checked. A broad
  name-only exemption is not used.
- Allow the already-used `node:sqlite`; let import-x own import resolution;
  retain explicit Node process exits and scripts without hashbangs.
- Permit JSON empty keys used by existing data. Keep duplicate keys, syntax,
  JSONC comments/trailing commas, and `.json` tsconfigs parsed as JSONC.

No application suppressions, automated `void` insertions or application fixes
were committed. Further exclusions need case-specific review, particularly
compiler-only negative contracts and intentional rejection propagation.

| Inspected finding                                                                                                                                          | Disposition / focused follow-up                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Async HTTP listeners, `acceptance/fresh-baseline-owner.test.mjs:38`, `acceptance/helpers/native-fresh-baseline.mjs:75`                                     | Actionable fixture error path: request-stream rejection escapes the returned async listener. Add a bounded fault-injection test and response/error handling. Static finding; no live fault injection claimed.       |
| Same rule in `acceptance/helpers/inprocess-runtime.mjs:151` and `native-cloudflare-http.mjs:5`                                                             | Existing explicit try/catch handles request work and writes failure responses; reviewed false-positive burden.                                                                                                      |
| Seven `return-await` reports, including `apps/ingestion/src/index.ts:77`, `game-publication.ts:242`, `source-evidence-capture.ts:323`, four deletion paths | Credible error-handling review targets: rejection bypasses that local catch. Verify whether catch/recovery should own that operation; do not mechanically await stale-owner paths. No production incident asserted. |
| `collection-recovery.ts:76` non-exhaustive switch                                                                                                          | Current default deliberately covers active states. Explicit grouped cases would guard future additions; no current missing state behavior.                                                                          |
| Two floating promises in `test/domain/catalogue-store.types.ts:6,8`                                                                                        | False positives for never-executed compiler contracts, not abandoned production work.                                                                                                                               |
| 19 regex backtracking reports                                                                                                                              | Credible bounded-input/performance review candidates; no exploit or latency regression proven.                                                                                                                      |
| Unsafe data, unnecessary conditions and object coercion                                                                                                    | Useful review surfaces, including external parsed values; most not individually verified. Guarded runtime defenses and library `any` need careful triage.                                                           |
| 79 duplicate-import reports, 127 regex quantifier/assertion reports, regex spelling preferences                                                            | Mostly optional cleanup; insufficient justification for migration by themselves.                                                                                                                                    |

There are only **19 reports across the five directly relevant typed families**:
floating promises (2), misused promises (4), invalid awaits (5), return-await (7)
and exhaustive switches (1). This is a tractable first correctness gate, unlike
making all strict-preset rules mandatory at once. The remaining unsafe-flow
backlog is a separate annotation and data-boundary project.

## Runtime, editing and formatting

Three sequential local samples, seconds; no other trial benchmark was running.
Fresh processes used a warm filesystem, not a flushed OS disk cache. The first
baseline pass after installation separately took 1.62 seconds; subsequent
baseline passes were 0.40/0.40 seconds. These are local observations, not CI SLAs. A later scope-correctness replay
while the full suite was running took 25.5 seconds; it is excluded from the
comparison below.

| Operation                                        | Samples                  |
| ------------------------------------------------ | ------------------------ |
| Biome, equivalent target list                    | 0.539 / 0.414 / 0.416    |
| Biome with additional promise/union rules        | 0.817 / 0.778 / 0.791    |
| ESLint, fresh process, no result cache           | 19.671 / 19.998 / 19.818 |
| ESLint cache: initial population, then unchanged | 19.999 / 1.602 / 0.898   |
| TS7, all five projects, sequential               | 1.458 / 1.368 / 1.385    |
| TS6 compatibility compiler, same five projects   | 8.978 / 9.119 / 8.991    |

All five projects pass both compilers. TS6-only offers a simpler compiler/API
ownership model but costs roughly 7.6 additional seconds here and gives up the
TS7 compiler/editor option. Coexistence is the preferred follow-up. Compiler
and lint caches are distinct: unchanged ESLint cache results are not evidence
that edits to imported type declarations invalidate every affected consumer.
Do not use a stale typed-lint cache as a CI correctness guarantee.

Persistent ESLint `lintText` over the same Worker probe reports all 17 messages
in **1.16 seconds initially, then 11/6 ms**. This models a warm lint service;
it is **not measured editor UI latency**. Promise diagnostics offer await
suggestions. Problem-only automatic fixing did not change the faulty Worker
probe; the known unsafe operations were not silently repaired by `void`.
Actual VS Code extension diagnostics, save actions and TS7 language-server
selection remain unverified.

Prettier preserves two spaces, 120 columns, double quotes, trailing commas and
semicolons. It runs separately with `eslint-config-prettier` last. Six sampled
files cover TS, `.mjs`, JSONC, tsconfig JSON, Markdown and YAML. Three were
unchanged; TS and tsconfig each changed +2/-7 lines, Wrangler JSONC +27/-27.
All outputs were stable on a second format. A small CLI regex auto-fix changed
`(0|[3-9]|[1-9][0-9]+)` to `([03-9]|[1-9]\d+)`; it is optional equivalent
spelling, not a correctness win. Source files stayed untouched.
[Prettier integration](https://prettier.io/docs/integrating-with-linters).

The formatter experiment's fail/write/pass check proves merge-base committed
changes, staged and unstaged edits, untracked filenames with spaces, and
preservation of unchanged files, generated Worker declarations and retained
fixtures. Lockfile/generated Ajv/prototype exclusions are explicit. Markdown
and YAML are now eligible when changed; formatting YAML is not workflow
validation. No repository-wide reformat occurred.

The original aggregate non-test check with candidate dependencies took 4.3
seconds locally, using Biome. Replacing its lint would add roughly 19 seconds
before formatting/test costs. The testing guide's approximately one-minute warm
quick-loop guidance is context; a complete migrated quick loop and hosted/editor
costs remain unmeasured. See [timings](eslint-303/time-timings.json) and
[editor/format measurements](eslint-303/editor-format.json).

## Improvements available without migration

Each compiler flag was enabled independently across all five existing projects:

| TS7 option                   | Result                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `noImplicitOverride`         | All pass unchanged                                                                                 |
| `noFallthroughCasesInSwitch` | All pass unchanged                                                                                 |
| `noImplicitReturns`          | One report: `apps/ingestion/vitest.config.ts:99`; intentional undefined return from its error hook |
| `exactOptionalPropertyTypes` | 91 project reports, **23 unique locations** across 19 files                                        |

Explicit override/fallthrough enforcement is a low-cost follow-up for either
toolchain. Review the Vitest hook's return policy and optional-property
construction separately; those are compiler benefits, not ESLint benefits.
See [compiler results](eslint-303/compiler-results.json) and
[diagnostics](eslint-303/compiler-diagnostics.json).

The three tested additional Biome rules improve local/imported promise,
synchronous callback and union-switch prevention with little added runtime.
They do not close the demonstrated generated D1/R2 declaration gap. Promoting
focused-test warnings to errors is also available within Biome. No baseline
compiler or Biome option was silently changed for this evaluation.

## Validation and retained guarantees

Validation status and exact commands are recorded in
[validation results](eslint-303/validation.json). Focused domain source-host-pacing,
API health, ingestion evidence-cleanup, Node acceptance smoke, frozen install,
and the **complete original non-test check** passed with the candidate graph.
The latter includes all five compiler projects, generated declarations/validators,
custom boundary/cycle/store/SQL enforcement, and both Worker build dry runs.
It proves dependency compatibility; it is not a passing ESLint migration gate.

The complete routine `pnpm run test:full` **passed all 1,533 tests**: 298 domain,
95 API, 787 ingestion and 353 acceptance. It completed in 1,089.95 seconds
(18.2 minutes), with no failed, cancelled or skipped acceptance cases.
No stress, extended capacity, live recapture, deployment or hosted CI was run
for this trial. No CI job identity, shard count, task interface, runtime binding,
application dependency or source behavior was changed in the ordinary checkout.
Generic import checks are additive: import-x's cycle rule omits type-only edges,
so it cannot replace the repository's boundary/cycle checks.
[import-x cycle limitations](https://github.com/un-ts/eslint-plugin-import-x/blob/master/docs/rules/no-cycle.md).

The independent [standards and specification reviews](eslint-303/review.md)
reported no actionable findings.

## Concrete migration follow-up

1. Keep TS7 `tsc` and the supported TS6 API alias with exact pins. Choose lasting
   shared-source and JavaScript project ownership; retain both Workers' own
   generated declarations and all five existing compiler commands. Keep the
   six implementation/declaration cases covered by the diagnostic corpus.
2. Start with core recommended correctness; typed floating/misused promises,
   invalid awaits, error-context return-await, exhaustive switches and error
   handling. Resolve the 19 focused typed findings with explicit intent and
   regressions at the relevant boundaries. Require handling/lifetime, never
   a mechanical `void` escape. Add unsafe-flow rules at validated TypeScript
   boundaries and annotated CLI/release inputs before expanding their scope.
3. Retain Vitest async/focus/matcher checks, JSON/JSONC duplicate detection,
   import-x resolution and selected Node API checks. Retain SonarJS ignored-return
   and Unicorn invalid-fetch checks demonstrated by the probes; remove their
   style-only/duplicated rules. Review regex correctness/backtracking checks;
   omit spelling/quantifier preferences unless separately wanted. The whole
   recommended/all plugin bundles are not the proposed gate.
4. Install Prettier and ESLint editor integration; configure per-language
   formatting, explicit ESLint save fixes and the TS7 language server. Verify
   open-file and changed-import diagnostics in Worker, CLI and both test
   runtimes, including real D1/R2 types. Preserve changed-file formatting and
   all exclusions; do not perform a mass reformat.
5. Review every proposed suppression and transitive/native dependency; keep
   strict pnpm policies. Re-run the corpus, format policy, focused checks,
   complete non-test check and full routine suite. Then verify a clean Linux
   install, full ready-PR CI and resulting main CI, preserving required job
   identities, generated checks, custom imports and Worker dry runs. Only after
   those pass should Biome be removed and ordinary lint/format tasks switched.
