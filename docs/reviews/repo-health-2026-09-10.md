# Repository health assessment — 10 September 2026

> Historical assessment. The pnpm/Corepack migration, Node pin, ESLint/Prettier
> cutover and package-command audit are now implemented. See the current
> [Toolchain](../toolchain.md), [Commands](../commands.md) and
> [Testing](../testing.md) guides. Recommendations below describe the earlier
> decision process, not outstanding migration requirements.

Evaluate Vite+ as the owner's preferred unified-toolchain candidate, with Biome
as the fallback, and adopt pnpm through Corepack as the selected package-manager
direction. Preserve TypeScript 7.0.2 and the existing test/validation contracts.
Pair that work with runtime consistency, a quieter lint baseline, checking
important operational JavaScript, and reducing expensive test setup where current
reports show it.

The subsequent [Biome/ESLint/Vite+ comparison](../research/2026-09-10-lint-toolchain-comparison.md)
updates the initial keep-Biome recommendation with actual Worker-type probes.
The owner subsequently chose one toolchain as a priority over combining Biome
and Oxlint. Vite+ supplies the stronger typed engine within an integrated suite;
its complete Worker/command/CI integration still needs a successful trial.

This assessment records the updated direction; the pnpm migration has not yet
been implemented. No application, dependency, test, CI or production
configuration was changed during the assessment.
The accompanying [tooling research](../research/2026-09-10-repo-tooling-options.md)
records current first-party references and migration tradeoffs.

## Baseline and evidence

Inspected clean checkout `cdff6f198bc7332a4dc89b2adf1a43b9d261d212` on
10 September. This already includes #299's testing reassessment and #300's
package-command cleanup. The
[testing guide](../testing.md), [reassessment](../testing-reassessment.md), and
[command reference](../commands.md) describe that current policy; earlier failed
runs in historical reviews do not describe the current result.

| Observation                                                                               | Evidence                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| One package manifest and lockfile; two separately deployed Workers                        | Root `package.json`; Worker configs under `apps/`                                                                                                   |
| 28 package scripts and 25 files under `scripts/`                                          | Tracked-file inventory; the latter includes release, recapture, generators and developer tooling                                                    |
| 51 domain, 13 API, 97 routine ingestion, 10 ingestion stress and 73 acceptance test files | Tracked `*.spec.ts` / `*.test.mjs` files in the respective suites; acceptance includes extended and benchmark selections                            |
| Local runtime differs from CI                                                             | Local Node 26.3.0 / npm 11.16.0; workflows select Node 22; `engines.node` is `>=22.18`; `@types/node` is 26.5.0                                     |
| Installed dependencies satisfy the top-level tree                                         | `npm ls --depth=0` passed                                                                                                                           |
| TypeScript checks pass                                                                    | `npm run typecheck` passed locally during this assessment                                                                                           |
| Lint passes with recurring diagnostics                                                    | Installed Biome 2.5.12 reported 859 files, zero errors, 35 warnings and 22 information diagnostics, about 0.65 seconds on this machine              |
| Current main CI passes                                                                    | [Run 34455848708](https://github.com/KeeprDigital/card-keepr/actions/runs/34455848708), exact inspected SHA, all nine jobs successful               |
| Ingestion remains the longest CI layer                                                    | Job durations including setup: 10m04s, 10m45s and 9m29s, against twelve-minute caps; JSON artifacts report 787 tests passed across the three shards |
| Dependency advisories remain in development tooling                                       | Fresh `npm audit --json`: five high-severity package entries; `npm audit --omit=dev --json`: zero reported vulnerabilities                          |

Full local tests were not rerun: the completed exact-commit hosted result is
available. These observations are a point-in-time sample, not a reliability or
security certification.

## Tool decisions

### Toolchain: evaluate Vite+, retaining Biome as the fallback

Lint performance is already small relative to tests. There is no measured
performance reason to replace it. The configuration deliberately formats only
changed files to avoid broad churn, and excludes generated output and retained
fixtures. Preserve that policy: a single repository-wide `biome check --write`
would change its scope.

The current warnings include unused variables/imports and four rule families
explicitly downgraded from errors in `biome.jsonc`. Resolve actionable findings,
record intentional exceptions close to the code where practical, and restore
the downgraded rules as each family becomes clean. Establish a no-new-warning
policy after clearing or explicitly accounting for the baseline.

The subsequent comparison enabled Biome's typed nursery rules and the equivalent
typed Oxlint rules on deliberate errors using the repository's generated Worker
declarations. Both caught ordinary local/imported promises; Oxlint additionally
reported unawaited D1/R2 operations that Biome missed in that setup. No production
defect is claimed from these probes. This is a concrete reason to evaluate
Vite+'s typed lint engine. The owner's unified-toolchain preference makes a
successful complete Vite+ migration the target rather than a permanent hybrid.
Verify lint/JSON/type coverage, formatting scope and custom tasks before removing
Biome, and pin the tested Vite+ release to manage beta and bundled-version risk.

ESLint remains attractive for specific plugins/custom rules, but current
typescript-eslint metadata excludes the repository's TypeScript 7.0.2. The
Cloudflare test plugin constrains Vitest 4.1, not this project's TypeScript
version; current CI already passes with TS7. Vite+ 0.3.1 bundles a matching
Vitest 4.1.11, so evaluate its broader workflow on actual Worker behavior rather
than reject it for a presumed version conflict. See the
[comparison and reproduction](../research/2026-09-10-lint-toolchain-comparison.md).

### pnpm through Corepack: preferred migration

The repository has one dependency graph and already commits its lockfile and
uses `npm ci` in CI. Multiple Worker deployables do not require separate npm
packages or a workspace. pnpm can still be valuable for its shared package
store, particularly with many checkouts, and stricter dependency resolution.
Those are valid reasons independent of monorepos.

The owner has selected pnpm with Corepack as a preference. No installation or
storage benchmark was collected, so the decision makes no measured speedup
claim. Implement it as a focused migration:

- Pin an exact, verified pnpm release in `package.json`'s `packageManager`
  field, retaining Corepack's generated integrity hash. Use Corepack to select
  the same pnpm version locally and in CI.
- Document and provision a compatible Corepack version, then enable its pnpm
  shim with `corepack enable pnpm`. Node 25 and later do not bundle Corepack,
  including the currently observed local Node 26 installation; bootstrap must
  handle that explicitly. See [Corepack setup and project pins](https://github.com/nodejs/corepack#readme).
- Import the existing lockfile, preserve the parent-specific dependency override,
  review native dependency build permissions, and retain `pnpm-lock.yaml` as the
  sole package lockfile after validation.
- Update nested npm/npx calls, current contributor commands, workflow install
  steps and caches together. CI should explicitly use
  `pnpm install --frozen-lockfile`; document the corresponding local setup.
- Validate Wrangler, generated output, native binaries, Worker tests, external
  CLI smoke and the existing full merge checks. Keep dependency upgrades
  separate from the package-manager migration wherever possible.

Standardize Node alongside this work. Choose the current validated Node 22 line
unless a separate upgrade is justified, add a version-manager file and align
Node declarations with it. Use one source for CI's selected runtime where
possible. The existing npm commands elsewhere in this assessment describe the
inspected baseline; their public names and coverage should survive migration to
pnpm.

#### Required CI scope and completion criteria

CI changes are part of the same pnpm/Corepack migration, not a later cleanup.
Update every workflow that installs or invokes the project's tooling:

| Workflow                        | Required migration coverage                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `ci.yml`                        | All five job definitions, including each ingestion/acceptance shard and draft smoke |
| `stress.yml`                    | Bounded and full selections                                                         |
| `test-suite-diagnostics.yml`    | Focused Worker selection, repeat execution and argument forwarding                  |
| `official-source-recapture.yml` | Installation and source-recapture tooling                                           |
| `production-preflight.yml`      | Installation and preflight tooling                                                  |
| `production-release.yml`        | Installation, Wrangler invocations and called release helpers                       |

The migration is complete only when:

- Each applicable job provisions Node and the selected Corepack release, then
  resolves pnpm from the committed `packageManager` pin before accessing its
  cache or running project commands.
- Install steps use `pnpm install --frozen-lockfile`. Replace npm-specific cache
  configuration and `package-lock.json` keys with the selected pnpm cache
  strategy and inputs, including its lockfile, version and install settings.
  Validate both cache misses and cache hits on Linux.
- Project npm/npx invocations are migrated, including nested helper calls.
  Check argument forwarding for file filters, shards, reporters and formatting
  bases. Using npm solely to bootstrap a pinned Corepack release is acceptable.
- Required job identities, three-shard matrices, draft/ready behavior,
  concurrency limits, temporary-storage cleanup, reporting and the exact-main
  production release gate remain intact. Update the existing release contract
  assertions wherever they depend on the changed command/setup structure.
- Full hosted CI passes on the migration review head, followed by the merged
  main commit. Validate other workflow setup and commands through existing
  local/contract checks and safe diagnostics; do not deploy or mutate production
  merely to validate this package-manager change.

### Tests: keep the boundaries; improve discovery and feedback

The test files already use standard runners:

- Vitest runs domain tests and the two Worker integrations.
- Node's built-in test runner executes acceptance tests as external processes.
- `scripts/acceptance-tier.mjs` selects tiers/shards and sets concurrency and
  deadlines; `scripts/ci-test.sh` supplies disposable hosted temporary storage.

These wrappers encode useful repository policy. They are not an in-house test
framework. Keep real D1/R2, controlled Workflow transitions, dedicated platform
binding proofs and selected HTTP/CLI journeys as required by `docs/testing.md`.

The existing `npm test`, `test:full`, individual suite filters, `--list` and
explicit capacity commands are a good public interface. Improve it in small ways:

1. Document a verified watch-mode invocation for each Vitest suite; root
   scripts currently use `vitest run`. Add an alias only if it improves common
   usage. Cloudflare watch lifecycle still needs validation.
2. Allow a focused routine acceptance file/name selection through the same
   wrapper. Today scenario selection is limited to extended/benchmark tiers,
   so direct Node invocations can bypass its concurrency/deadline policy.
3. Preserve machine-readable acceptance failure/duration artifacts, as ingestion
   already does. Review a few recent hosted samples before changing scheduling.
4. Consider a root Vitest projects config only if unified editor discovery or
   cross-suite selection is a recurring problem. Preserve suite exclusions,
   separate bindings and the current total concurrency limits; collecting
   projects together must not accidentally start all three suites at once.

Do not add Nx, Turborepo, Make or another custom dispatcher just to relocate the
28 commands. There is no package task graph or measured build-cache need here
that requires one. They can be reconsidered if independent packages and builds
are introduced later.

## Maintenance priorities

### First: consistent tooling and managed dependency updates

Address Node/pnpm/Corepack/type declaration consistency and the lint warning baseline in
small reviewable changes. Add reviewed scheduled dependency update proposals
(Dependabot or Renovate) if that workflow is wanted; no configuration is tracked
for either today. Group the compatible Cloudflare testing/runtime packages and
keep Vitest within the installed plugin's declared peer range. Do not auto-merge
these upgrades or upgrade all packages to their latest major together.

The development audit entries are `sharp`, `undici`, and their
Miniflare/Wrangler/plugin parents; they are not five proven application exploits.
The maintainers' [sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
and [Undici advisory](https://github.com/nodejs/undici/security/advisories/GHSA-4cwx-7wf7-3272)
give affected and fixed versions. Review reachability and a supported dependency
combination. The audit's suggested major/alpha replacements and downgrades are
not an upgrade plan.

This debt is already acknowledged in the
[current toolchain disposition](../evidence/private-launch-cleanup-20260910.md#current-toolchain-disposition).
That document deliberately retains direct acceptance Miniflare 4 while
Wrangler/plugin use their upstream Miniflare 5 dependencies. Any attempt to
unify them must revisit the recorded compatibility evidence rather than assume
duplicate versions are accidental.

### Next: type-check operational JavaScript incrementally

The five existing TypeScript projects mainly cover Workers, domain TypeScript
and test support. None enables `checkJs`; only ingestion test support enables
`allowJs`. CLI, release tools and much of the acceptance harness are JavaScript
without equivalent static checking.

Start with a dedicated, narrowly included tooling config and JSDoc/`checkJs` for
high-value CLI, process execution and release helpers. Alternatively convert a
small cohesive module to TypeScript when there is another reason to edit it.
Measure and resolve the initial findings before expanding. Retain the external
CLI and release contract tests. A bulk `.mjs` conversion would change direct
Node execution and import contracts unnecessarily.

The two Worker tsconfigs also repeat the same compiler options. A shared base
would make them easier to maintain, while keeping each Worker's generated
bindings and each test environment's types separate.

### Then: improve test cost using the existing reports

The longest reported ingestion files in the latest successful run include:

| File                                   | Observed file duration |
| -------------------------------------- | ---------------------: |
| `reconciliation-card-identity.spec.ts` |                 282.6s |
| `reconciliation-progress.spec.ts`      |                 271.5s |
| `identity-corrections.spec.ts`         |                 234.9s |

These are whole-file elapsed times on concurrent hosted runners, not individual
test-body deadlines or CPU profiles. They identify places to inspect, not proof
of a particular bottleneck. Use the retained per-test reports and focused
diagnostics to find repeated setup or duplicated whole-publication journeys.
Keep the existing boundary strategy; no blanket rewrite, larger timeout,
additional shard or automatic retry is justified by this sample.

### Finally: make maintenance code easier to navigate

`scripts/` mixes development (`dev`, `format`, generators, import checks), CI
support, production release logic and source recapture. Grouping those by
purpose would help discovery while retaining the documented package-script and CLI entrypoints.
Move cohesive groups only after checking every relative path, workflow caller
and release contract. Existing `scripts/source-evidence/` offers a precedent.

The five CI job definitions repeat the dependency setup/cache sequence. A small
local composite action could centralize that sequence without changing job
names, matrices or gate semantics. This is optional maintenance: preserve the
OS/architecture/exact-Node/manifest/lockfile/settings cache isolation and cache-hit
behavior. The pnpm migration must also account for the pinned pnpm version and
its configuration. Branch protection and the exact-main production guard depend
on the current job identities.

Keep archived audit evidence distinct from current operating guidance. When
closing health work, reconcile the existing GitHub issues (#271/#272 and the
separate stress/capacity work) against their acceptance criteria rather than
creating duplicate tracking or declaring them complete from one green run.

## Suggested order

1. pnpm migration through Corepack, exact package-manager pin, consistent Node
   and Node types, reproducible local and CI setup.
2. Isolated Vite+ integration and lint/format/type coverage comparison, preserving
   TS7 and all CI contracts; adopt on successful validation or retain Biome.
3. Targeted dependency advisory review and a reviewed update cadence.
4. Incremental static checking of operational JavaScript.
5. Focused/watch test ergonomics, acceptance reports, then measured test-cost
   improvements as affected families are changed.
6. Optional script organization and CI setup deduplication.

Keep the pnpm/Corepack migration separate from lint cleanup, dependency upgrades
and any test-runner restructuring so each result can be assessed on its own.
