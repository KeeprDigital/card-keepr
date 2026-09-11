# Biome, ESLint and Vite+ for Card Keepr

> Historical assessment, superseded by the completed pnpm/Corepack and
> ESLint/Prettier migrations. Use [Toolchain](../toolchain.md) and
> [Commands](../commands.md) for current setup and supported commands.
> The findings below retain the original investigation context.

Assessment and bounded diagnostic probes, 10 September 2026. This expands the
[initial tooling assessment](2026-09-10-repo-tooling-options.md) and revises its
emphasis: fast lint execution alone is not a sufficient reason to stay with a
linter. Detecting mistakes through this repository's actual Worker types matters
more. The owner's pnpm/Corepack preference and all-six-workflow CI migration
requirements remain in place.

## TypeScript 7 is already in the working baseline

The owner wants to preserve the ability to use TS7. The manifest and lockfile
already select TypeScript **7.0.2**. The inspected main commit
`cdff6f198bc7332a4dc89b2adf1a43b9d261d212` passed the
[full CI run](https://github.com/KeeprDigital/card-keepr/actions/runs/34455848708),
including TypeScript checks and Worker testing.

The installed Cloudflare plugin **1.1.6** declares peers on **Vitest**,
`@vitest/runner` and `@vitest/snapshot` at `^4.1.0`; it does not declare a
TypeScript peer restriction. Its own development dependency on TypeScript 5.8.3
does not constrain this consuming project's compiler. The known plugin issue
is a **Vitest 5** upgrade, not using **TypeScript 7**.
[Plugin metadata](https://registry.npmjs.org/@cloudflare/vitest-plugin/1.1.6),
[repo lockfile](../../package-lock.json), [testing guide](../testing.md).

Keep that distinction throughout selection: ESLint's current typed-lint
integration has a TS7 support gap, whereas the current Worker test integration
already runs alongside TS7. Vite+'s matching Vitest peers are encouraging but
still require validation of its aliased Vite implementation. Preserving TS7 is
an adoption criterion; a compiler downgrade is not part of this proposal.

## Recommendation under the owner's unified-toolchain preference

The owner prefers one maintained toolchain over a Biome/Oxlint combination.
**Evaluate Vite+ first, with Biome as the fallback.** The earlier incremental
hybrid recommendation minimized migration scope but is not the preferred
destination under this requirement.

Vite+ integrates formatting, typed JS/TS linting, TypeScript checks, Vitest and
task execution. Its current Vitest version matches this repo, and pnpm/Corepack
can coexist with it. Wrangler, Node acceptance and the repository's generated
file/import/release checks still need to run through custom tasks; the integrated
toolchain supplies their interface, not their domain behavior.
[Combined checks](https://viteplus.dev/guide/check),
[task execution](https://viteplus.dev/guide/run).

Adoption depends on a successful isolated migration: prove actual Cloudflare
execution, equivalent type-check and lint coverage (including existing JSON/JSONC
checks), formatting scope, editor behavior and all required CI jobs before
removing Biome. The probes below support Vite+'s lint engine but do not prove
the complete suite replaces every current check.

The main risks are beta changes, coupling package upgrades to bundled
Vite/Vitest versions, differences in formatting and rule coverage, and changed
task/cache semantics. In particular, a future Vite+ release could move beyond
Cloudflare's supported Vitest range. Pin a verified release and assess upgrades
as a complete toolchain; do not force incompatible internal versions merely to
keep the suite moving. This is a prospective risk, not a conflict in 0.3.1.

If that trial cannot preserve the existing contracts with reasonable
configuration, **stay on Biome**. ESLint with Prettier remains a fallback when
specific plugins are decisive and TS7 compatibility is resolved. Running
Prettier as an ESLint rule gives one invocation but adds separate dependencies
and integration; Prettier's maintainers generally advise against that approach
because of extra overhead and indirection.
[Prettier integration guidance](https://prettier.io/docs/integrating-with-linters).

These are recommendations, not applied migrations. No application, manifest,
lockfile, CI config or repository test was changed for this comparison.

## What the repository needs from these tools

The two Workers use D1/R2, durable transitions, external fetches and substantial
asynchronous orchestration. Important mistakes include discarded storage
promises, async callbacks passed to synchronous APIs, unhandled error paths,
unsafe values at document boundaries, and missing cases when a state union
changes. Imported and generated types therefore matter to lint quality.

The repository also has `.mjs` CLI/release helpers, several TypeScript project
configs, generated Worker declarations, custom import boundaries, retained
fixtures, six workflows and many Markdown documents. A new linter must identify
which files actually receive typed analysis. Directory traversal alone does
not prove type coverage for JavaScript or files outside a tsconfig.

Existing checks already separate linting, formatting, type checking, generated
files, import contracts and Worker bundle dry runs. A replacement `check`
command must preserve that aggregate meaning. See
[manifest](../../package.json), [testing policy](../testing.md),
[format wrapper](../../scripts/format.mjs) and
[import rules](../../scripts/catalogue-import-boundary.mjs).

## Comparing the options fairly

| Option                                                | Main value here                                                                                        | Material cost or constraint                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Biome alone                                           | Existing simple setup; JS/TS/JSON checks and formatting; very fast current baseline                    | Its promising typed rules use its own inference and remain experimental; the probe below exposed Worker declaration gaps                               |
| ESLint + typescript-eslint, keeping a formatter       | Mature JS plugin/custom-rule model; compiler-backed typed checks; independent choice of formatter      | Current TS 7 compatibility gap; more parser/project/plugin configuration; language coverage and formatting still need explicit ownership               |
| Standalone Oxlint + tsgolint, keeping Biome initially | Compiler-based typed rules aligned with TS 7; can add only the missing checks; no test/build migration | Additional engine/config and native tooling; map rule parity before replacing existing checks; custom JS plugin support has limits                     |
| Vite+                                                 | Oxlint/Oxfmt plus coordinated Vite/Vitest, config, task discovery and execution                        | Broader adoption and beta release line; custom Worker/acceptance/check scripts still exist; Vite alias, cache and environment behavior need validation |

ESLint is not a formatter replacement by itself. Keeping Biome for formatting
is a valid ESLint or Oxlint configuration; switching to Prettier/Oxfmt is not
required to obtain different lint rules. Conversely, Vite+ is not an independent
lint engine: `vp lint` uses Oxlint.
[ESLint plugins](https://eslint.org/docs/latest/extend/plugins),
[typescript-eslint formatting guidance](https://typescript-eslint.io/users/what-about-formatting/),
[Vite+ lint](https://viteplus.dev/guide/lint).

### Biome: strengths and limits

Installed Biome is 2.5.12. The earlier baseline lint completed in about 0.65s,
with 35 warnings and 22 informational findings. That measures the current
configuration, not equivalence to a compiler-backed lint suite.

Biome has real typed rules; dismissing it as syntax-only would be wrong.
`noFloatingPromises`, `noMisusedPromises` and `useExhaustiveSwitchCases` are
available, but the first two are nursery rules and depend on Biome's own type
inference. Rule presence does not establish identical inference through every
generated declaration and library overload.
[Floating promises](https://biomejs.dev/linter/rules/no-floating-promises/javascript/),
[misused promises](https://biomejs.dev/linter/rules/no-misused-promises/javascript/).

Biome supports GritQL plugins, so it is extensible. Those pattern-based plugins
are a different extension model from ESLint's JS rule and parser APIs. Its
current language support table lists Markdown and YAML support as in progress.
Oxfmt's broader formatting support can be useful for this repo's workflow and
documentation files, but formatting YAML is not workflow validation.
[Biome plugins](https://biomejs.dev/linter/plugins/),
[Biome language support](https://biomejs.dev/internals/language-support/),
[Oxfmt overview](https://oxc.rs/docs/guide/usage/formatter.html).

### ESLint: a strong design option with a current compatibility problem

Registry metadata checked during this assessment reports ESLint 10.10.0 and
typescript-eslint 8.70.0. The latter declares TypeScript `>=4.8.4 <6.1.0`, matching
the published support page, while the repository installs TypeScript 7.0.2.
This is verified package metadata as well as documentation, not merely an
assumption from an old compatibility article.
[ESLint manifest](https://registry.npmjs.org/eslint/10.10.0),
[typescript-eslint manifest](https://registry.npmjs.org/typescript-eslint/8.70.0),
[supported versions](https://typescript-eslint.io/users/dependency-versions/).

The installed TypeScript 7 package exports a version-only default module and
new unstable APIs, rather than the old full compiler API at its default export.
Simply ignoring a peer warning is not evidence that typed ESLint integration
will work. An isolated older TypeScript for linting might be investigated, but
would create a second compiler interpretation to maintain. This assessment did
not install an unsupported ESLint/TS 7 combination or downgrade the repository.

ESLint becomes attractive if we need specific domain/architecture rules or
plugins whose behavior matters more than migration simplicity. The existing
regex-based import checks offer a possible future use case, but a replacement
must preserve the actual cluster-direction and public-index contracts; generic
import lint rules do not automatically replace them. `projectService` improves
typed project discovery but still requires intentional file/project ownership.
[ESLint custom rules](https://eslint.org/docs/latest/extend/custom-rules),
[typed project service](https://typescript-eslint.io/blog/project-service/).

### Oxlint: relevant typed coverage, available independently

Oxlint delegates typed rules to tsgolint using TypeScript's Go implementation.
The stable v7 engine tracks TypeScript 7.0.2. Published rule coverage is extensive,
but this recommendation relies on the relevant rule behavior below rather than
total rule counts.
[Stable typed engine](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable.html),
[type-aware setup](https://oxc.rs/docs/guide/usage/linter/type-aware.html).

Its JavaScript plugin API supports much of ESLint's API but is still alpha.
It does not support arbitrary custom parsers or JS plugin rules requiring
TypeScript type information. Built-in typed rule ports do not imply that every
ESLint typed plugin works. Native import/Vitest/Node/Promise rules provide
another useful area to evaluate, deliberately rather than enabling every preset.
[Plugin limits](https://oxc.rs/docs/guide/usage/linter/js-plugins.html).

Keep the existing five-project TypeScript check initially. Combining compiler
diagnostics with typed linting may be possible later, but equivalence across
both Workers, their tests, shared source and operational JavaScript has not been
established here.

## Bounded comparison using Worker declarations

Tools were installed only in a disposable directory outside the repository.
No probe code was executed. The diagnostic input used a copy of this checkout's
ingestion `worker-configuration.d.ts`, a strict tsconfig, one imported async
function and the code below. Biome used explicit error-level settings for its
three nursery rules; Oxlint enabled only the corresponding three typed rules.

Oxlint **1.81.0** and tsgolint **7.0.2001** were selected because they are exactly
the versions bundled by Vite+ **0.3.1**. Biome was the installed **2.5.12**.
This compares the lint engines, not execution through `vp` or ESLint.

| Deliberately faulty example                  | Biome        | Typed Oxlint |
| -------------------------------------------- | ------------ | ------------ |
| Discard a local async function's Promise     | Reported     | Reported     |
| Discard an imported async function's Promise | Reported     | Reported     |
| Discard `db.prepare(...).run()`              | Not reported | Reported     |
| Discard `bucket.put(...)`                    | Not reported | Reported     |
| Pass an async callback to `forEach`          | Reported     | Reported     |
| Use `bucket.get(...)` as an `if` condition   | Not reported | Reported     |
| Omit a state from a union switch             | Reported     | Reported     |

Neither engine flagged the three controls: awaited storage, an awaited
`Promise.all`, and explicitly ignored `void localWrite()`. The last is an allowed
lint escape, not rejection handling; do not auto-fix discarded work by inserting
`void`. The Promise-valued condition can also be detected by TypeScript in this
simple example; the unawaited storage calls are the clearest additional lint
value over ordinary type checking.

The Biome result was reproduced after replacing the declaration symlink with
a real copy and removing declaration exclusions. Both local and imported
Promise checks fired, confirming the rules were active. This result demonstrates
a gap with this ambient Worker declaration setup; it is not a universal
4/7-versus-7/7 accuracy benchmark, an exhaustive false-positive study, or a claim
that Biome cannot improve or handle other declaration shapes.

Two exploratory source scans were also performed without writing fixes:

- Biome's two async rules reported no findings over 657 processed files in
  `src`, `apps`, `cli`, `scripts` and `test/domain`.
- Oxlint's same two rule families reported no findings over 374 files in `src`
  and the ingestion Worker source, using a temporary config extending that
  Worker's tsconfig. It reported about 2.34s elapsed locally.

The selections differ and cannot be used for a speed comparison. Neither scan
certifies every file received equivalent type information. No existing
production defect is asserted from this experiment.

### Reproducing the diagnostic input

In an isolated directory, copy `apps/ingestion/worker-configuration.d.ts` to
`worker-configuration.d.ts`. Use a tsconfig with `strict: true`, `noEmit: true`,
`target: "ES2022"`, `module: "ESNext"`, `moduleResolution: "Bundler"`,
`lib: ["ES2022"]`, `skipLibCheck: true`, `allowImportingTsExtensions: true`,
and `include: ["*.ts"]`.

`service.ts`:

```ts
export async function persistRecord(): Promise<void> {}
```

`probe.ts`:

```ts
import { persistRecord } from "./service.ts";
async function localWrite(): Promise<void> {}
export async function probe(db: D1Database, bucket: R2Bucket, ids: string[]) {
  localWrite();
  persistRecord();
  db.prepare("SELECT 1").run();
  bucket.put("key", "value");
  ids.forEach(async (id) => {
    await bucket.put(id, "value");
  });
  if (bucket.get("key")) {
    return "found";
  }
  await bucket.put("awaited", "value");
  void localWrite();
  await Promise.all(ids.map((id) => bucket.put(id, "value")));
}
export function stateLabel(state: "pending" | "approved" | "rejected") {
  switch (state) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
  }
}
```

Configure Biome with `linter.rules.preset: "none"` and nursery rules
`noFloatingPromises`, `noMisusedPromises`, `useExhaustiveSwitchCases` set to
`"error"`. Run `biome lint probe.ts`.

From the isolated directory containing the Oxlint dependencies, run:

```sh
oxlint --type-aware --tsconfig tsconfig.json -A all \
  -D typescript/no-floating-promises \
  -D typescript/no-misused-promises \
  -D typescript/switch-exhaustiveness-check probe.ts
```

## Vite+: assess the whole workflow, not just lint

The [separate Vite+ investigation](2026-09-10-vite-plus-fit.md) verifies the
published package and migration rules. The decisive points are:

- Vite+ 0.3.1 is MIT-licensed and beta. Its bundled Vitest 4.1.11 satisfies
  Cloudflare plugin 1.1.6's `^4.1.0` peers. A blanket Vitest incompatibility
  rejection would be incorrect. The aliased Vite implementation still needs a
  real Worker smoke test, type-resolution and cleanup/watch validation.
- Corepack pins are supported. Keep Corepack as the effective package-manager
  entrypoint; adopting Vite+ does not require changing the selected pnpm policy.
- Unified configuration, coordinated releases, task discovery and one toolchain
  are legitimate advantages. The cost is accepting a coordinated update unit
  and maintaining the repo-specific parts alongside it.
- Built-in `vp test` does not mean this repository's combined quick suite;
  `vp build` does not mean two Wrangler dry runs; `vp check` does not include all
  existing generated/import/build checks. `vp run` can host these scripts, but
  does not eliminate their policy.
- Package scripts are uncached by default; config-defined tasks default to
  caching. Preserve fresh Worker/acceptance/diagnostic/live/production execution
  and temporary-state cleanup when moving tasks. Dependency caching and test
  result caching must be assessed separately.

[Vite+ metadata](https://registry.npmjs.org/vite-plus/0.3.1),
[commands](https://viteplus.dev/guide/run),
[released cache policy](https://github.com/voidzero-dev/vite-plus/blob/v0.3.1/docs/guide/cache.md).

For this repository, standalone typed lint demonstrates the lint-engine benefit.
The owner now prioritizes Vite+'s unified workflow; that integration remains to
be demonstrated. Test an isolated migration with the
existing three Vitest configs, the Node acceptance wrapper, Wrangler dry runs,
Corepack setup and all required CI jobs before deciding. Do not equate a
successful `vp check` with this repo's existing aggregate validation.

## Proposed adoption criteria

1. Preserve the pnpm/Corepack migration and all-six-workflow requirements as
   agreed, separately reviewable from linter/formatter changes.
2. Trial one pinned Vite+ release in isolation, preserving TS7, Corepack and the
   supported Vitest version. Verify all TypeScript project environments, actual
   Worker execution, Node acceptance, Wrangler dry runs and teardown.
3. Map JS/TS and JSON/JSONC checks, rule severities, fixture exclusions,
   suppressions and editor behavior before removing Biome. Review every real
   typed-lint finding and deliberate exception; positive/negative diagnostic
   examples should verify that the integration is active.
4. Review Oxfmt output and retain changed-file formatting. Preserve custom
   aggregate command coverage and disable task-result caching where fresh
   execution is required. Update all six workflows and prove full hosted CI.
5. Adopt Vite+ if those criteria pass with maintainable configuration. Otherwise
   retain Biome; reconsider ESLint/Prettier once its typed integration fits TS7
   or a specific indispensable plugin warrants the additional setup.
