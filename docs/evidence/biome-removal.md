# Biome removal

The subsequent [package command audit](package-command-audit.md) removes the
migration-only tooling gate described in this historical removal record.

The owner requested complete removal after the staged implementation at
`3db4f86e30dcdfb90c16d22481a5abf6ea8e8fbc`. This follow-up switches the ordinary
commands to the already validated ESLint and Prettier configuration, superseding
the earlier decision to retain Biome pending editor and hosted CI verification.
It does not claim those remaining checks have passed.

## Changes

- `lint` runs the focused ESLint correctness gate with zero warnings. `check`
  and CI run it once, followed by the retained tooling contracts.
- `format` and `format:check` run Prettier with the existing merge-base,
  staged/unstaged and untracked file selection. Generated output, retained
  fixtures, diagnostic inputs and prototypes remain excluded.
- Remove the Biome dependency, platform packages, configuration and two source
  suppressions. Their explanatory comments remain useful; neither needs an
  ESLint suppression. Remove the temporary tool-specific command aliases.
- The installed VS Code integrations already select ESLint and Prettier.
  TypeScript 7, compiler projects, strict pnpm policies, Worker dependencies,
  CI job identities and shard counts remain unchanged.

The focused gate is intentionally not an exact reproduction of Biome's entire
recommended preset. Its rules and reviewed exceptions remain those established
by the staged implementation. Formatter differences apply only to changed files;
there is no repository-wide baseline rewrite.

## Validation

- Local frozen installation passes. The lockfile removes only Biome's package
  family; no remaining dependency version changed. `pnpm why @biomejs/biome`
  returns no package, and its installed package and executable links are absent.
- The complete `pnpm run check` passes in a disposable worktree containing the
  exact removal diff. This verifies the actual ordinary commands while excluding
  the owner's unrelated untracked research notes from the validation copy.
- TypeScript continues to report 7.0.2 for `tsc` and 6.0.3 for `tsc6`.
- A fresh `node:26.8.2-bookworm` ARM64 container with an empty pnpm store passes
  frozen installation, confirms the Biome executable is absent, and passes the
  complete `pnpm run check`, including both Worker dry runs. Installation takes
  23.5 seconds, excluding container startup and Corepack bootstrap.
- `pnpm run test:full` passes all 1,536 routine tests: 298 domain, 95 API,
  788 ingestion and 355 acceptance. Acceptance reports zero failures,
  cancellations or skips.

The existing formatter contract now exercises the ordinary command. Before the
switch it failed to report changed Markdown; with Prettier it passes, proving the
same write/check behavior for JavaScript, JSONC, Markdown, YAML and commented
TypeScript project files, including filenames with spaces and exclusions.

## Review

Both independent reviews inspected the staged diff against
`3db4f86e30dcdfb90c16d22481a5abf6ea8e8fbc`. Standards: zero documented breaches
or heuristic findings. Spec: zero actionable findings. Additional formatting
changes follow the existing branch ratchet and introduce no application behavior
changes.

## Editor and hosted CI

VS Code's typed diagnostics can stay stale after an imported declaration changes.
Restart ESLint and use the uncached `pnpm run lint` as the authoritative check.
This is the already recorded upstream limitation, not a reason to keep a second
formatter or linter installed. The native TypeScript package selection and its
one-time editor picker remain documented in [toolchain setup](../toolchain.md).

Full ready-PR and resulting main CI remain the repository's merge/release gates.
Local removal does not substitute local or container evidence for hosted results.
