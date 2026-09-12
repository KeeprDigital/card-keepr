# Development

Start with [local setup](../README.md#local-development).
`.node-version`, `package.json#packageManager` and `pnpm-workspace.yaml` own runtime,
package-manager and dependency-build policy. Corepack manages pnpm; the existing
Node version manager selects Node. If another pnpm shadows it, use `corepack pnpm`
and inspect PATH rather than replacing global tools.

## Commands

`pnpm run` lists the scripts in `package.json`. Pass arguments directly after the
script name, without npm's extra `--`. Use `pnpm exec` for an installed binary.

```sh
pnpm run dev
pnpm run test:ingestion apps/ingestion/test/evidence-cleanup.spec.ts
pnpm run test:acceptance http-fixture
pnpm run format
pnpm run format:check --since=origin/main
pnpm --silent run keepr health --json
```

[Testing](testing.md) owns suite selection and review requirements.
`pnpm run check` runs lint, formatting, type checks, generated-file checks, import
boundaries and both Worker build dry runs; it contains no tests.

## Dependencies and editors

Use `pnpm install --frozen-lockfile` after a lockfile change. Deliberate dependency
updates use pnpm and commit the manifest, lockfile, settings and any dependency
patch together. Strict peers and reviewed native-build permissions remain enabled.
The [test-plugin patch](../patches/README.md) is needed for real SQLite backup/restore.
Validate a focused Worker file before broader suites after runtime updates.

CI uses the [shared setup action](../.github/actions/setup-toolchain/action.yml).
It caches dependency source packages, then repeats frozen installation and approved
native setup. Test and operational outcomes are never cached.

ESLint owns lint; Prettier owns formatting. The formatter selects changed,
staged/unstaged and untracked files against the branch's merge base, defaulting to
`origin/main` then `main`. Use `--since=REF` to override. Keep formatting scoped to
changed files; retained fixtures and generated outputs have separate ownership.

TypeScript's native compiler owns compilation; typescript-eslint uses the pinned
compatibility API. Worker/test projects and `tsconfig.tooling.json` define their
respective type coverage. In VS Code, install the recommended workspace extensions
and select the custom TypeScript version. Update the configured pnpm SDK location
after compiler upgrades. Restart the ESLint server after changing imported types;
the uncached CLI lint result is the review check for stale editor diagnostics.

After binding or document-schema changes, run the applicable generator and commit
its output:

```sh
pnpm run generate:worker-types
pnpm run generate:validators
pnpm run check:generated
```

## CLI boundary

The CLI parses input, reads secrets from environment/descriptors and makes HTTP
requests. Ingestion owns target resolution, confirmation, canonical release plans
and digests. The CLI forwards the server-issued dispatch bytes unchanged.
`cli/lib/http-client.mjs` is the shared transport: HTTPS except loopback, no URL
credentials or redirects. JSON/problem decoding and exit codes are shared.
The [administration contract](../contracts/ADMINISTRATION.md) owns wire behavior.

Pre-worker release tools retain named SQL and independent provider verification;
they must work before the new Worker is active. They do not rebuild server plans.
