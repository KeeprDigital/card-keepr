# Issue #301 toolchain migration evidence

Implementation baseline: `cdff6f198bc7332a4dc89b2adf1a43b9d261d212`.
The conditional outcome is pnpm/Corepack adoption with Biome retained. Vite+
is not adopted; JSON/JSONC lint coverage blocks this release's trial.

## Versions and dependency preservation

Registry metadata was rechecked on 10 September 2026. The owner then requested
the latest stable Node and pnpm, superseding the issue's original Node 22
constraint, and explicitly selected pnpm 12.3.4 after checking the current tags.
The final target is Node 26.8.2, Corepack 0.36.0 and pnpm 12.3.4. Corepack
generated the committed package-manager integrity hash. The lockfile was
imported from the baseline npm lock before removing it.

| Component | Retained resolution |
| --- | --- |
| Biome | 2.5.12 |
| TypeScript | 7.0.2 |
| Cloudflare Vitest plugin | 1.1.6 |
| Vitest / runner / snapshot | 4.1.11 |
| Vite (now declared directly for acceptance imports) | 8.2.2 |
| Wrangler | 4.130.0 |
| Direct acceptance Miniflare / workerd | 4.20260730.0 / 1.20260730.1 |
| Plugin/Wrangler Miniflare / workerd | 5.20260908.0-alpha / 1.20260908.1 |
| Direct / plugin esbuild | 0.28.2 / 0.28.1 |
| Direct entities / parse5's entities | 8.1.0 / 8.0.0 |

No dependency ranges were forced or simulator generations unified. pnpm uses
strict peer checks, strict build approval and an allowlist for esbuild/workerd.

## Vite+ trial and concrete stopping condition

A detached worktree at the baseline tested Vite+ 0.3.1, whose published bundle
contains Vitest 4.1.11, Oxlint 1.81.0, Oxfmt 0.66.0 and oxlint-tsgolint 7.0.2001.
The trial retained direct Vitest, runner and snapshot 4.1.11 and used the
published `vite` alias to `@voidzero-dev/vite-plus-core@0.3.1`.

The initial strict install rejected the alias's version `0.3.1` against
Vitest/mocker's Vite `^6 || ^7 || ^8` peers. Vite+'s migration implementation
adds peer exceptions for its managed aliases, so this is not evidence that
Cloudflare and Vite+ are fundamentally incompatible. No peer check was disabled.
The installed trial binaries reported internal Vite 8.2.2; the API health file
ran through `corepack pnpm exec vp test run --config apps/api/vitest.config.ts
apps/api/test/health.spec.ts` and passed nine tests. This was diagnostic execution
from the partially completed install, not a claim of a validated installation.

The material stopping condition was the existing JSON/JSONC lint contract.
Create these files at a maintained repository path in the trial:

`vp-duplicate.json`:

```json
{ "target": "staging", "target": "production" }
```

`vp-duplicate.jsonc`:

```jsonc
{
  // Conflicting target values must be rejected.
  "target": "staging",
  "target": "production"
}
```

Observed results:

| Invocation | Result |
| --- | --- |
| `corepack pnpm exec biome lint vp-duplicate.json vp-duplicate.jsonc` | Exit 1; two `lint/suspicious/noDuplicateObjectKeys` errors |
| `corepack pnpm exec vp lint vp-duplicate.json vp-duplicate.jsonc` | No files found to lint; neither duplicate analyzed |
| `corepack pnpm exec vp fmt vp-duplicate.json vp-duplicate.jsonc`, then the same with `--check` | Check exits 0 with both duplicate keys still present |
| `corepack pnpm exec vp lint --no-error-on-unmatched-pattern vp-duplicate.json vp-duplicate.jsonc` | Exit 0, no duplicate diagnostics |
| `corepack pnpm exec vp check vp-duplicate.json vp-duplicate.jsonc` | Formatting passes; lint cannot start because it selects zero files |

Oxlint's supported inputs are JS/TS and framework script blocks. Its JS plugin
support does not accept custom parsers, so an ESLint JSON parser plugin is not
a supported configuration bridge. Removing Biome would lose an existing check;
retaining it alongside Oxlint or writing a separate JSON linter would depart
from the requested maintained integrated interface. Per the issue's fallback,
this migration keeps Biome and stops the Vite+ portion. Full Vite+ rule mapping,
typed-promise probes, all compiler projects, ingestion/domain execution, task
and runtime ownership checks remain requirements for any later trial. They
are not claimed as completed here.

## Coverage disposition

Because Biome is retained at the exact existing version, JS/TS and JSON/JSONC
coverage, imports, severities and suppressions remain identical:

| Existing policy | Result |
| --- | --- |
| Recommended lint preset | Unchanged, across the maintained tree |
| `style/noNonNullAssertion` | Still off |
| `correctness/noVoidTypeReturn` | Still warning |
| `suspicious/noControlCharactersInRegex`, `noImplicitAnyLet`, `useIterableCallbackReturn` | Still warnings |
| JSON/JSONC syntax and duplicate object keys | Retained through Biome lint |
| JSON Schema `then` suppression in curated field schemas | Unchanged |
| Constructible function suppression in curated native target test | Unchanged |
| Prototype, captured fixtures, generated Worker declarations and Ajv exclusions | Unchanged |
| Lockfile exclusion | Renamed from npm to pnpm lockfile |
| Import handling | Existing lint rules retained; no import-organizing command added |
| Formatting | Same settings and script; merge-base plus working tree and untracked files |

No blanket suppression, `void` insertion or repository-wide reformat was applied.
The five-project compiler check, generated artifacts, boundaries/cycles, two
Wrangler dry runs, quick/full tiers, three ingestion and acceptance shards,
deadlines, tmpfs cleanup and exact-main release gate remain in place.

## Validation

Validation results and remaining hosted requirements are recorded below as
checks complete. Production, live recapture and remote-data mutation workflows
are not dispatched to test this migration.

Sources: [Vite+ 0.3.1 metadata](https://registry.npmjs.org/vite-plus/0.3.1),
[Cloudflare plugin 1.1.6 metadata](https://registry.npmjs.org/@cloudflare/vitest-plugin/1.1.6),
[Vite+ released migration rules](https://github.com/voidzero-dev/vite-plus/blob/v0.3.1/docs/guide/migrate-rules.md),
[Oxlint supported inputs](https://oxc.rs/docs/guide/usage/linter.html),
[JS plugin parser limitation](https://oxc.rs/docs/guide/usage/linter/js-plugins.html).

Initial Node 22/pnpm 10 trial results (superseded as the target environment):

- Fresh `corepack pnpm install --frozen-lockfile` passed on macOS ARM64/Node
  22.23.2, with esbuild and both workerd installs executed. A comparison of every
  package name/version in the imported and original locks found no additions,
  removals or version changes. All five compiler projects passed.
- Focused domain source-host-pacing-mode: 4 tests; API health: 9 tests;
  ingestion evidence cleanup: 23 tests. The ingestion run wrote its requested
  JSON reporter file. CLI help, name filtering, shard listing, extended and
  benchmark listing, and explicit formatter base forwarding were exercised.
- Both Node acceptance smoke tests passed, including native publication and
  SQL restore. The selected release gate/provider, recapture and tier contracts
  passed all 120 tests without live publisher or production access.
- `pnpm run check` passed: Biome lint, changed-file formatting, all five compiler
  projects, generated declarations/validators, import boundaries/cycles and both
  Wrangler dry runs. `format:check --since=origin/main` and shell syntax checks
  also passed. Existing lint warnings were not hidden or promoted away.
- The actual CI Corepack setup script was exercised in a temporary directory:
  Node remained the selected 22.23.2 binary; Corepack 0.35.0 and its pnpm 10.34.5
  shim resolved from that directory. Global developer tooling was unchanged.

## Updated Node 26 / pnpm 12 target

The initial Linux runs ([manual](https://github.com/KeeprDigital/card-keepr/actions/runs/34470715449),
[ready PR](https://github.com/KeeprDigital/card-keepr/actions/runs/34470884601))
were canceled when the owner requested the newer toolchain. Before cancellation,
full acceptance exposed an undeclared direct dependency: three acceptance files
import Vite, previously visible only through npm's transitive hoisting. The
existing focused files reproduced `ERR_MODULE_NOT_FOUND` before the correction.
The manifest now declares the already-locked Vite 8.2.2 directly. pnpm's
`install --fix-lockfile --no-frozen-lockfile` repaired the new importer's peer
reference; it did not update any application package versions. The three affected
files then passed all four tests on Node 26.8.2. No new test seam or duplicate
regression test was needed.

pnpm 12 uses `pmOnFail: error`, `runtimeOnFail: error`, `allowBuilds`, and explicit
`sideEffectsCache: false`. This keeps Corepack in control and ensures clean
cache-hit installs execute the approved native hooks instead of reusing their
previous output. Its first lockfile YAML document records pnpm itself and its
platform executables; the second retains the complete application dependency
graph. Comparison against the original npm graph still finds no application
package additions, removals or version changes. The extra package-manager
entries are pnpm 12's expected metadata, not an application dependency upgrade.

The exact CI bootstrap script passes on Node 26.8.2 and resolves Corepack 0.36.0
and pnpm 12.3.4 from its temporary directory. `pnpm exec node` reports the selected
26.8.2 binary. The complete non-test check also passes on the updated versions;
full and hosted evidence follows after final validation.

The updated focused domain/API/ingestion selection passes (4/9/23 tests), as do
both acceptance smoke files. A fresh frozen install and a second offline frozen
install pass with pnpm 12.3.4; the latter reuses all 105 installed packages and
reruns both esbuild and both workerd hooks. The full application lock retains
the baseline versions; the package-manager metadata adds only pnpm and its
platform distributions. Actionlint 1.7.12 passes all six updated workflows.
The follow-up Spec review confirms the Vite reference is fixed and reports no
remaining implementation findings.
