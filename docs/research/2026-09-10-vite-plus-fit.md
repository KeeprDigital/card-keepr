# Vite+ fit for Card Keepr — 10 September 2026

> Historical assessment, superseded by the completed pnpm/Corepack and
> ESLint/Prettier migrations. Use [Toolchain](../toolchain.md) and
> [Commands](../commands.md) for current setup and supported commands.
> The findings below retain the original investigation context.

Vite+ is a credible candidate, including with this repository's current Cloudflare
test integration. Its strongest linting capabilities are also available through
standalone Oxlint. The decision is therefore whether unified configuration,
commands and maintenance justify changing the surrounding toolchain, rather than
whether Vite+ is necessary to obtain better lint rules.

This note checks official documentation, published npm metadata and package
contents. It does not claim a successful Vite+ migration: no repository tooling
was installed or changed, and no Worker tests were run as part of this research.

## What is available now

| Component           | Verified version / status                                                          | Practical implication                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Vite+               | `0.3.1`, published 8 September 2026; MIT; documentation calls the product beta     | Evaluate a current released version, not the earlier announcement or stale private/commercial descriptions |
| Bundled Vitest      | `4.1.11`, with matching runner, snapshot, mocker and other bundled Vitest packages | Within the current Cloudflare plugin's declared peer range                                                 |
| Bundled lint stack  | Oxlint `1.81.0`, `oxlint-tsgolint` `7.0.2001`                                      | TypeScript-aware checks do not require adopting ESLint                                                     |
| Bundled formatter   | Oxfmt `0.66.0`                                                                     | Formatter migration is part of the normal Vite+ proposal                                                   |
| Standalone releases | Oxlint `1.82.0`, Oxfmt `0.67.0`                                                    | The suite deliberately pins its own combination; standalone tools can be upgraded independently            |
| Runtime requirement | Vite+ `^20.19.0                                                                    |                                                                                                            | ^22.18.0 |     | >=24.11.0` | The repository's intended Node 22 baseline can satisfy it |

Version sources: [Vite+ 0.3.1 manifest](https://registry.npmjs.org/vite-plus/0.3.1),
[release](https://github.com/voidzero-dev/vite-plus/releases/tag/v0.3.1),
[Oxlint 1.82.0 manifest](https://registry.npmjs.org/oxlint/1.82.0),
[Oxfmt 0.67.0 manifest](https://registry.npmjs.org/oxfmt/0.67.0).
Status source: [Vite+ troubleshooting](https://viteplus.dev/guide/troubleshooting).

The maintainers explicitly open-sourced Vite+ under MIT and described the
toolchain as free. There is no documented required commercial subscription for
the local toolchain in these sources. This does not make a claim about future
hosted services or support contracts.
[First-party announcement](https://voidzero.dev/posts/announcing-vite-plus-alpha).

## Lint and format value without the suite

`vp lint` is Oxlint. Vite+ adds configuration integration and coordinated tool
versions; it is not a separate lint engine. Its `lint.options.typeAware` enables
typed rules and `typeCheck` adds compiler diagnostics.
[Vite+ lint](https://viteplus.dev/guide/lint).

Oxlint's tsgolint v7 was declared stable in July 2026, tracks TypeScript 7.0.2,
and the announcement reports 59 of typescript-eslint's 61 type-aware rules.
That is relevant to this repository's installed TypeScript 7.0.2. It is stronger
evidence than a blanket claim that all fast linters lack type-aware analysis.
The supported standalone path is `oxlint` plus `oxlint-tsgolint`.
[Type-aware stable announcement](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable.html),
[usage](https://oxc.rs/docs/guide/usage/linter/type-aware).

Oxlint includes native Node, Promise, import and Vitest rule families, though
they must be enabled deliberately. Its ESLint-compatible JavaScript plugin API
remains alpha and does not support custom parsers or custom rules that depend on
TypeScript type information. That matters if ESLint's specific plugin ecosystem
is the reason for changing tools; native typescript-eslint rule ports and full
ESLint plugin compatibility are different capabilities.
[Built-in plugins](https://oxc.rs/docs/guide/usage/linter/plugins),
[JavaScript plugin limits](https://oxc.rs/docs/guide/usage/linter/js-plugins.html).

Oxfmt supports YAML, Markdown and TOML as well as JS/TS/JSON, potentially extending
consistent formatting to workflow and documentation files. Its compatibility
target is Prettier; that does not promise Biome-identical output. Defaults and
some supported options differ, and arbitrary Prettier plugins are unsupported.
[Formatter overview](https://oxc.rs/docs/guide/usage/formatter.html),
[migration compatibility](https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier).

Both standalone manifests mark their `vite-plus` peer optional. Card Keepr can
choose Oxlint with the existing formatter, or Oxlint and Oxfmt, without adopting
Vite+ or changing its test and build resolution. This is a useful lower-scope
candidate if lint quality wins but suite consolidation does not.
[Oxlint metadata](https://registry.npmjs.org/oxlint/1.82.0),
[Oxfmt metadata](https://registry.npmjs.org/oxfmt/0.67.0).

## Cloudflare compatibility: promising, not yet executed

Installed `@cloudflare/vitest-plugin@1.1.6` requires `vitest`, `@vitest/runner`
and `@vitest/snapshot` in `^4.1.0`. Vite+ 0.3.1 provides `4.1.11`, so the declared
version ranges agree. Rejecting current Vite+ because it forces Vitest 5 would
be incorrect.
[Cloudflare published manifest](https://registry.npmjs.org/@cloudflare/vitest-plugin/1.1.6),
[Vite+ manifest](https://registry.npmjs.org/vite-plus/0.3.1).

Published Vite+ files make `vite-plus/test` and `vite-plus/test/node` thin exports
of ordinary `vitest` and `vitest/node`. This was checked directly in the release
tarball. The old `@voidzero-dev/vite-plus-test` package is not part of the 0.3.1
dependency list. The Cloudflare package itself still imports `vitest/worker`
and `vitest/runtime`, reinforcing the need for one consistent upstream module
identity.
[Vite+ published source archive](https://registry.npmjs.org/vite-plus/-/vite-plus-0.3.1.tgz),
[Cloudflare published source archive](https://registry.npmjs.org/@cloudflare/vitest-plugin/-/vitest-plugin-1.1.6.tgz).

The documented migration aliases Vite to the matching Vite+ core release and
pins Vitest across the dependency graph. Under pnpm, it adds a direct `vite`
dependency because an override alone does not supply a peer dependency. It
retains direct Vitest when an installed integration has a required Vitest peer,
as Cloudflare does here. Test imports normally change to `vite-plus/test*`;
upstream module augmentations and retained compiler type references keep their
upstream identities. These changes are broader than replacing Biome.
[Released migration rules](https://github.com/voidzero-dev/vite-plus/blob/v0.3.1/docs/guide/migrate-rules.md).

**Inference:** the peer ranges remove one obvious blocker, but cannot prove
Cloudflare's Worker pool, module transforms, mocks and cleanup work through the
aliased Vite implementation. An isolated trial should preserve the three
existing test configs, run one domain file and one small file from each Worker,
check type resolution and watch cleanup, then run the existing full CI before
adoption. The repository explicitly requires a small Worker check on Vitest
upgrades and preserves real storage isolation.
[Repository testing policy](../testing.md),
[current Worker configuration](../../apps/ingestion/vitest.config.ts).

## Corepack and CI

There is no inherent pnpm/Corepack conflict. Released Vite+ documentation reads
the standard `packageManager` declaration and supports integrity hashes produced
by Corepack, using the same pnpm tarball hashing convention.
[Released installation guide](https://github.com/voidzero-dev/vite-plus/blob/v0.3.1/docs/guide/install.md).

By default, Vite+ can manage Node and package-manager shims itself. Released
`vp env off` switches both to system-first selection; `vp env off pnpm` narrows
that choice. System-first has a managed fallback, so it is not by itself proof
that Corepack executed an install. Preserve the owner's Corepack setup and
explicit `pnpm install --frozen-lockfile`, then verify the effective binary and
version in clean local and hosted environments. This is an integration choice
to test, not a reason to discard either preference.
[Released environment guide](https://github.com/voidzero-dev/vite-plus/blob/v0.3.1/docs/guide/env.md).

The published local `vp` entrypoint is a Node script, so evaluating project-local
commands does not require globally replacing a developer's environment manager.
[Published Vite+ archive](https://registry.npmjs.org/vite-plus/-/vite-plus-0.3.1.tgz).

Vite+ also offers `setup-vp` to provision CI and cache package-manager data. It
does not require replacing our existing setup to obtain lint rules. If adopted,
pin that action and the toolchain; audit all six workflows already listed in the
health assessment. Dependency caching is separate from task-result caching.
[Vite+ CI](https://viteplus.dev/guide/ci),
[agreed CI requirements](../reviews/repo-health-2026-09-10.md#required-ci-scope-and-completion-criteria).

## What it does and does not simplify here

Vite+ supports running existing package scripts and offers an interactive task
selector, dependency ordering and caching. Those are real discoverability and
maintenance benefits even outside a monorepo. However, its built-in commands
cannot be replaced by package scripts: `vp dev`, `vp build`, `vp test` and
`vp check` retain their Vite+/Vitest meanings. Custom scripts use `vp run`.
[Task runner](https://viteplus.dev/guide/run).

The repository-specific consequences are:

| Current contract                                                            | Requirement for any trial                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `dev` starts the coordinated Worker development environment                 | Keep the custom script, invoked through `pnpm run dev` or `vp run dev`                              |
| `build` runs Wrangler deployment dry runs for two Workers                   | Preserve both dry runs; built-in `vp build` is not a substitute                                     |
| `test` runs domain, API and Node acceptance smoke sequentially              | Preserve orchestration; built-in `vp test` covers Vitest only                                       |
| `check` includes generators, import boundaries/cycles and build dry runs    | Keep these gates in addition to Vite+'s lint/format/type checks                                     |
| Acceptance tiers select files, shards, concurrency and deadlines            | Retain the selection policy and external Node runner unless a separate change justifies moving them |
| Formatting applies to changed files and excludes generated/retained content | Preserve that scope and review formatter differences before enabling a new formatter                |

These observations come from [package scripts](../../package.json),
[acceptance runner](../../scripts/acceptance-tier.mjs),
[formatting wrapper](../../scripts/format.mjs) and [Biome config](../../biome.jsonc).
Vite+ can host these commands; it does not make their underlying policy obsolete.

## Cache correctness matters more than a fast replay

Vite Task leaves package scripts uncached by default but caches tasks defined in
`vite.config.ts` by default. A hit replays logs, restores written outputs and
skips execution. A per-task `cache: false` cannot be overridden by a general
cache flag. Moving scripts into configuration therefore changes behavior unless
cache policy is explicit.
[Released cache guide](https://github.com/voidzero-dev/vite-plus/blob/v0.3.1/docs/guide/cache.md).

Automatic tracking records filesystem access. It cannot generally infer
environment-variable reads or whether a path is stable input, generated output
or disposable tool state. Cooperative tracking currently adds richer metadata
for `vp build`; that is not a promise for Wrangler, workerd or Node acceptance
process trees.
[Automatic tracking](https://viteplus.dev/guide/automatic-data-tracking).

**Recommendation:** initially disable result caching for Worker and acceptance
tests, stress/benchmarks, diagnostics, migrations, release/preflight and source
recapture. This is a repository-specific precaution, not a claim that deterministic
storage tests can never be cached. Fresh executions currently establish runtime
and storage behavior; live checks and performance measurements depend on inputs
that source hashes alone cannot represent. Keep temporary databases outside any
restored task outputs. Audit `TMPDIR`, `KEEPR_*`, Wrangler and release environment
forwarding when changing task orchestration; do not assume shell inheritance
matches the present commands.
[Repository resource policy](../testing.md),
[temporary-storage wrapper](../../scripts/ci-test.sh),
[task environment configuration](https://github.com/voidzero-dev/vite-plus/blob/v0.3.1/docs/config/run.md).

Cross-run GitHub Actions task caching is explicitly experimental upstream.
The guide requires stable local hits and measurement of transfer overhead.
There is no measured task-cache benefit for this repository in this assessment.
[GitHub Actions task cache](https://viteplus.dev/guide/github-actions-cache).

## Decision conditions

The owner has now prioritized one toolchain, so Vite+ is the first candidate to
validate and Biome is the fallback. Standalone Oxlint remains useful comparison
evidence, but the Biome/Oxlint hybrid is no longer the preferred destination.

Adopt Vite+ if an isolated migration proves the actual Cloudflare combination,
Corepack remains the effective install path, and all existing commands and CI
evidence retain their coverage. Include explicit comparison of current JSON/JSONC
checks and formatting scope before declaring Biome fully replaced. Its beta
status is a reason for deliberate pinning and verification.

Coordinated versions also couple upgrades: a future Vite+ release could require
a Vitest version outside Cloudflare's peer range. Stay on a verified release
until the complete combination is supported and tested. The currently inspected
0.3.1 combination does not have that version conflict.

Keep Biome if the migration cannot preserve the existing contracts with
maintainable configuration. Prefer ESLint/Prettier if specific supported plugins
or custom typed rules become necessary and its TS7 compatibility is resolved.
The [updated comparison](2026-09-10-lint-toolchain-comparison.md) records this
decision order and the risks under the unified-toolchain preference.
