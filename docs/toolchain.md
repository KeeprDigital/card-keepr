# Toolchain

The supported interface is Corepack-managed pnpm. Biome remains the formatter
and linter after the conditional Vite+ trial in [issue #301](https://github.com/KeeprDigital/card-keepr/issues/301).
Vite+ is not an installed dependency. The [trial record](evidence/toolchain-301.md)
explains the JSON/JSONC lint blocker and the limits of the compatibility evidence.

## Installation and ownership

Follow [local setup](../README.md#local-development). `.node-version` pins Node
26.8.2 for local development and every Linux workflow. Corepack 0.36.0 is
installed explicitly because Node 25+ no longer includes it. npm is used only
to bootstrap Corepack, not to install or execute project dependencies.

During implementation the owner requested the latest stable Node and pnpm,
superseding issue #301's original Node 22 baseline. Registry/release checks on
10 September 2026 selected Node 26.8.2, pnpm 12.3.4 and Corepack 0.36.0. These
exact versions are pinned for reproducibility; do not use a moving `latest`
tag in CI. Node runs the local development/test tooling; the deployed Workers
still run on Cloudflare's existing runtime and compatibility dates.

`package.json#packageManager` pins pnpm 12.3.4 with Corepack-generated SHA-512
integrity metadata. `pnpm-workspace.yaml` sets `pmOnFail: error` and
`runtimeOnFail: error`, so pnpm cannot resolve mismatches by downloading another
package manager or runtime. Use the existing developer version manager or CI's
setup-node action to select Node.
Check `node --version`, `corepack --version`, `pnpm --version`, and
`command -v node corepack pnpm` when diagnosing an environment. If another pnpm
shadows Corepack, `corepack pnpm <arguments>` selects the declared version.

Run `pnpm install --frozen-lockfile` for a fresh checkout or after pulling a
lockfile change. To deliberately update dependencies, use `pnpm add` or
`pnpm update`, review the lockfile, then prove a frozen install. Do not regenerate
an npm lockfile. The migration imported the existing npm resolution before
removing it; it did not update the application or simulator dependencies.

Vite 8.2.2 is now an explicit development dependency because three acceptance
files import its server API directly. This is the same version previously
available through npm's transitive dependency hoisting.

The scoped `parse5>entities` override stays at 8.0.0, while the direct `entities`
dependency stays at 8.1.0. Strict peer validation remains enabled. Only esbuild
and workerd may run dependency build scripts, including both retained versions
of each. A new unapproved build script fails installation through `strictDepBuilds`;
review its purpose before changing `allowBuilds`. Do not disable the
guard or silently skip a native dependency's required setup.

CI's shared setup script installs Corepack into a temporary runner directory and
adds its pnpm shim to the job PATH. It does not replace the runner's global tools.
All six workflows cache the pnpm store, keyed by OS, architecture, exact Node and
pnpm versions, lockfile, manifest, settings and the Corepack setup script. Every
job still installs with `--frozen-lockfile`, rebuilding the project links and
running approved native setup even on cache hits (`sideEffectsCache: false`
prevents reusing prior install-hook output). No test, diagnostic, stress,
recapture, migration, preflight or release result is cached.

## Commands and arguments

[Commands](commands.md) is the authoritative task list. Use `pnpm run <task>`;
`pnpm test` is the quick combined test and `pnpm run test:full` is all routine
coverage. The full non-test command is `pnpm run check`. Development still starts
two Workers and builds still perform two Wrangler dry runs. All local test
layers remain sequential with their existing per-layer concurrency limits.

pnpm forwards arguments after the script name without npm's extra separator:

```sh
pnpm run test:ingestion apps/ingestion/test/evidence-cleanup.spec.ts -t 'owner cleanup'
pnpm run test:ingestion --shard=1/3 --silent=passed-only --reporter=default --reporter=json --outputFile.json=test-results/ingestion.json
pnpm run test:acceptance --shard=1/3 --list
pnpm run test:acceptance:extended --list
pnpm run test:benchmark --list
pnpm run format:check --since=origin/main
pnpm --silent run keepr health --json
```

Use `pnpm exec <binary>` for direct installed tools. Shell scripts and subprocesses
inherit the selected Node, pnpm PATH and environment, including `TMPDIR`,
`WRANGLER_LOG_PATH`, `KEEPR_TEST_SUITE` and benchmark inputs. `scripts/ci-test.sh`
still owns the disposable tmpfs and its exit cleanup. No environment filtering
or task scheduler has been introduced.

## Before another Vite+ trial

Use a disposable worktree and pin a concrete release; Vite+ is beta and updates
its bundled tools together. Read that release's migration rules and registry
metadata, not an old recommendation. At minimum:

1. Check the installed Cloudflare plugin's Vitest, runner and snapshot peers
   against every bundled Vitest package. Retain direct peer edges where needed.
   Follow the documented Vite core alias rules for pnpm and inspect any peer
   exception; never disable peer validation to hide an incompatible graph.
2. Reproduce the JSON and JSONC duplicate-key failures in the trial record.
   Account for lint semantics independently of formatting and map the complete
   Biome recommended preset, severity overrides, two suppressions and exclusions
   before removing Biome. Avoid a permanent hybrid or a bespoke replacement
   JSON linter merely to make the migration pass.
3. Verify typed lint with both valid and invalid imported, D1 and R2 promises.
   Resolve real diagnostics deliberately. Keep TypeScript 7 and prove all five
   existing compiler projects and options, retaining the explicit compiler task
   wherever Vite+'s check does not cover them.
4. Run focused domain, API, ingestion and Node acceptance smoke, then full
   validation. Preserve both direct acceptance Miniflare and the separate
   plugin/Wrangler runtimes. An API smoke alone is not compatibility proof.
5. Preserve the formatter's merge-base, staged/unstaged and untracked selection.
   Use unambiguous `vp run <task>` entries for the complete repository tasks;
   built-in `vp check`, `vp test`, `vp dev` and `vp build` have different coverage.
   Keep operational and Worker/acceptance task-result caching disabled, preserve
   environment forwarding, and verify Corepack and Node still own execution.
6. Validate all six workflows, a clean Linux install and a store-cache hit,
   full ready-PR CI, and the actual merged-main CI. Never deploy, recapture live
   publisher content or mutate remote data solely for toolchain validation.

Sources: [Corepack usage](https://github.com/nodejs/corepack#readme),
[pnpm CLI/runtime settings](https://pnpm.io/settings/cli),
[pnpm build permissions and cache](https://pnpm.io/settings/build),
[Vite+ 0.3.1 migration rules](https://github.com/voidzero-dev/vite-plus/blob/v0.3.1/docs/guide/migrate-rules.md),
[Oxlint language support](https://oxc.rs/docs/guide/usage/linter.html),
[Oxlint JS plugin limitations](https://oxc.rs/docs/guide/usage/linter/js-plugins.html).
