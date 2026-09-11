# Repository tooling options

> Historical assessment, superseded by the completed pnpm/Corepack and
> ESLint/Prettier migrations. Use [Toolchain](../toolchain.md) and
> [Commands](../commands.md) for current setup and supported commands.
> The findings below retain the original investigation context.

Investigated 10 September 2026 against the checked-out repository and first-party
documentation. This is an assessment, not a migration or performance benchmark.
No tests, installs, dependency changes or application edits were performed for
this note. The recommendations below are judgments from that evidence.

The later [Biome/ESLint/Vite+ comparison](2026-09-10-lint-toolchain-comparison.md)
supersedes the preliminary linter recommendation below. It includes isolated
diagnostic probes. With the owner's subsequent preference for one toolchain,
Vite+ is now the candidate to validate and Biome is the fallback; the incremental
hybrid is no longer the preferred destination. It also confirms TS7 is in the
passing Worker-test baseline: the Cloudflare plugin's constraint is on Vitest,
whereas current typescript-eslint has the separate TS7 compatibility gap.

## Recommendation

Keep Biome and the existing Vitest/Node test split. Following this assessment,
the owner selected pnpm through Corepack as the preferred package-manager
direction. Include that migration with version consistency, rule enforcement
and test discoverability in the health work. This preference does not depend on
a demonstrated installation bottleneck or a claimed benchmark improvement.
The two Workers share one private package; their separation is a runtime and
resource boundary, not evidence that package workspaces are needed.
Sources: [manifest](../../package.json), [two-Worker ADR](../adr/0009-two-workers-separate-read-and-mutation.md).

The committed lockfile resolves Biome **2.5.12**, Vitest **4.1.11**, Cloudflare's
Vitest plugin **1.1.6**, TypeScript **7.0.2**, Wrangler **4.130.0** and the direct
Miniflare dependency **4.20260730.0**. The plugin's installed peer dependencies
require Vitest, `@vitest/runner` and `@vitest/snapshot` in **^4.1.0**. Treat that
compatibility range as a constraint, not a reason to update to Vitest 5 because
its documentation is now the default website. The repository already records
the failed Vitest 5 upgrade. Sources: [lockfile](../../package-lock.json),
[testing guide](../testing.md).

## Biome and alternatives

The current configuration deliberately formats changed files and leaves four
rule categories as warnings while existing findings are repaired. Replacing the
formatter would not pay down those findings and could create another broad
formatting diff. A useful next step is to resolve each warning class and restore
its error severity. Warnings do not fail Biome's CLI unless
`--error-on-warnings` is used. Sources: [Biome configuration](../../biome.jsonc),
[format wrapper](../../scripts/format.mjs), [Biome rule severity](https://biomejs.dev/linter/#change-rule-severity).

Biome does have type-aware linting. Its types domain enables project scanning
and type inference, with an associated performance cost. The installed 2.5.12
schema includes `noFloatingPromises` and `noMisusedPromises` under `nursery`.
Current `noFloatingPromises` documentation also marks it experimental, with
information severity by default; the repository does not explicitly enable it.
A bounded evaluation of async rules against actual Worker code is sensible:
review useful findings, false positives and runtime before making them a gate.
Do not assume this replaces TypeScript checks or proves every async path safe.
Sources: [types domain](https://biomejs.dev/linter/domains/#types),
[floating promises](https://biomejs.dev/linter/rules/no-floating-promises/javascript/),
[current configuration](../../biome.jsonc).

ESLint with typescript-eslint is worth considering when specific needed rules
or plugins justify it. Typed rules use TypeScript's checking APIs, and
`projectService` is the recommended setup; this adds whole-project analysis
cost. There is a concrete compatibility question here: the published support
matrix retrieved today declares TypeScript `>=4.8.4 <6.1.0`, while this repository
uses 7.0.2. That is a documented-support gap, not proof that every version fails;
verify a compatible release before proposing it as a drop-in replacement.
Sources: [typed linting](https://typescript-eslint.io/getting-started/typed-linting/),
[supported versions](https://typescript-eslint.io/users/dependency-versions/).

Oxlint is another candidate for a measured typed-linting experiment: its
integration uses `tsgolint` and TypeScript's Go implementation, with an additional
`oxlint-tsgolint` dependency. Its capabilities alone do not establish better
results on this codebase. Avoid adding a second broad linter, or replacing the
existing typecheck, without demonstrated findings and verified configuration
compatibility. Source: [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html).

## npm versus pnpm; selected direction: pnpm through Corepack

Staying with npm does not mean giving up reproducible installation. `npm ci`
requires a lockfile, rejects manifest/lockfile disagreement and does not rewrite
either file. The existing CI has a cache for installed dependencies and uses
`npm ci` on misses, so compare against that actual baseline when measuring a
switch. Sources: [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/),
[CI](../../.github/workflows/ci.yml).

pnpm's useful differences are its shared content-addressed store and a default
dependency layout that exposes declared direct dependencies at the root.
Sharing package files can matter across many projects or worktrees, and stricter
resolution can expose accidental imports of transitive dependencies. These are
legitimate reasons to choose pnpm even for one package, but they do not by
themselves promise faster tests or a simpler command menu. Source:
[pnpm motivation](https://pnpm.io/motivation).

A migration would need to handle these specific costs:

- Import `package-lock.json` to `pnpm-lock.yaml`, inspect the resulting graph and
  keep one authoritative lockfile. `pnpm import` supports npm lockfiles.
  [Import documentation](https://pnpm.io/cli/import).
- Translate the existing parent-specific `parse5` → `entities@8.0.0` override
  while retaining the separate direct `entities@8.1.0` dependency. pnpm documents
  parent selectors such as `parent>child` in its overrides configuration.
  [Manifest](../../package.json), [pnpm overrides](https://pnpm.io/settings/dependency-resolution#overrides).
- Select and pin the pnpm release through Corepack, update nested npm
  scripts, contributor commands, workflow install steps and cache identities.
  Review the release scripts that invoke `npx --no-install`; merely changing the
  lockfile leaves those npm assumptions in place.
  [Manifest](../../package.json), [CI](../../.github/workflows/ci.yml),
  [release script](../../scripts/fresh-baseline-release.mjs).
- Review dependency build permissions. The lockfile marks `esbuild`, `workerd`
  and optional macOS `fsevents` installations as having scripts. pnpm has
  disabled automatic dependency postinstall execution since v10 and documents
  explicit trusted build configuration. Decide which builds are required and
  verify actual binaries on developer macOS and CI Linux.
  [Lockfile](../../package-lock.json), [pnpm build policy](https://pnpm.io/supply-chain-security#block-risky-postinstall-scripts).
- Validate module resolution, generated artifacts, Worker dry runs, focused
  Worker tests and the normal merge checks after migration. Measure cold/warm
  installation and disk use before declaring an improvement.
  [Repository validation policy](../testing.md).

Corepack is the selected version-management mechanism. Record an exact pnpm
version and generated integrity hash in `package.json`'s `packageManager` field;
provision a compatible Corepack release in developer and CI setup and enable
its pnpm shim with `corepack enable pnpm`. Corepack is not bundled with Node 25
or later, so it cannot be assumed present on the currently observed Node 26
developer runtime. Source: [Corepack installation and packageManager pins](https://github.com/nodejs/corepack#readme).

Use `pnpm install --frozen-lockfile` explicitly in CI once the imported lockfile
is validated. Match cache identities and native dependency build policy to the
selected pnpm version. Source: [pnpm install](https://pnpm.io/cli/install).

CI migration is required in the same change, covering all six existing
workflows: routine CI, stress, focused diagnostics, source recapture, production
preflight and production release. This includes caches, project command calls,
release helpers and affected release contract assertions, while retaining the
existing required checks and runtime/resource policy. See the
[assessment's CI completion criteria](../reviews/repo-health-2026-09-10.md#required-ci-scope-and-completion-criteria)
for the inspected workflow inventory and validation requirements.

pnpm's default documentation currently identifies itself as 12.x; verify the
chosen release's Corepack compatibility and configuration before pinning it.
The pnpm/Corepack preference is selected; an exact version and the migration
implementation remain outstanding.

## Test execution and command organization

Keep Vitest for domain and Worker tests. Cloudflare recommends its integration,
which executes tests in the Workers runtime with direct bindings and storage
isolation. Keep Node's test runner for the existing acceptance tests unless
unifying them would demonstrably simplify setup and reporting. Node already
provides a standard test runner; replacing the Worker integration with it would
require rebuilding or changing the Worker-specific fixtures, not merely changing
the command. Sources: [Cloudflare integration](https://developers.cloudflare.com/workers/testing/vitest-integration/),
[Node test runner](https://nodejs.org/api/test.html),
[acceptance selector](../../scripts/acceptance-tier.mjs).

The acceptance wrapper has repository policy to preserve: tier selection,
explicit opt-in to expensive journeys, listing without startup, weighted shards,
bounded concurrency and deadlines. A generic task runner would still need this
policy somewhere. Prefer thin public commands and one documented selector over
moving equivalent orchestration into another dependency.
Sources: [selector](../../scripts/acceptance-tier.mjs),
[tier definitions](../../acceptance/helpers/test-tiers.mjs), [testing guide](../testing.md).

Vitest 4 supports a root `test.projects` configuration pointing at the existing
configs, with named `--project` selection. This is an optional discoverability
improvement, not a prerequisite for a healthy single-package repository. Keep
Cloudflare plugins scoped to Worker projects and the domain environment scoped
to Node. Preserve sequential local layers: projects run in parallel by default,
while `sequence.groupOrder` can order groups. This repository's combined setup
has not been validated, and per-project worker limits must still be checked.
Sources: [Vitest 4 projects](https://v4.vitest.dev/guide/projects),
[Vitest 4 sequencing](https://v4.vitest.dev/config/sequence#sequence-grouporder),
[Cloudflare configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/),
[repository resource policy](../testing.md).

The smaller immediate improvement is discoverable Vitest watch mode and focused
file selection, while retaining `npm test` as quick feedback and `test:full` as
routine regression coverage. Keep extended/capacity work explicitly selected.
Sources: [Cloudflare watch support](https://developers.cloudflare.com/workers/testing/vitest-integration/),
[existing command contract](../testing.md).
