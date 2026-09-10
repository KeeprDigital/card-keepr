# Focused ESLint migration: staged implementation

Historical record: the owner's subsequent request to remove Biome is implemented
in the [removal follow-up](biome-removal.md). The results below describe the
earlier staged migration.

This implements the concrete follow-up in [the #303 evaluation](eslint-303.md)
from `5fd7308c640b742459975e19596b55ffaf48606c` on 11 September 2026.
The focused ESLint gate is clean and runs in `check` and the existing CI `lint`
job. Biome remains installed and owns ordinary `lint`, `format` and
`format:check`. Prettier's explicit commands use the same changed-file selector.
This is a staged migration, not a claim that the final retirement gates passed.
The [implementation review](eslint-migration-review.md) records both review axes
and the resolved findings.

## Gate and coverage

The gate uses core recommended rules with TypeScript's core-rule replacements,
floating/misused promises, invalid awaits, error-context return-await, exhaustive
switches, thrown/rejected errors, import resolution, selected Node APIs, Vitest
async/focus/matcher checks, JSON/JSONC syntax and duplicate keys, ignored return
values, invalid fetch options, and selected regex correctness/backtracking checks.
It does not load the plugins' broad recommended/all bundles. Regex quantifier
preferences and the broad unnecessary-condition/unsafe-flow backlog are deferred.
Unsafe-flow rules start at `src/http/bounded-json.ts` and the now annotated
`cli/lib/http-client.mjs`, which is shared by CLI and release tools.

The exact package versions and supported TS6 API alias from the evaluation are
retained. `tsc` resolves TS7 7.0.2 and `tsc6` reports TS6 6.0.3. Application,
Cloudflare, Vitest and Miniflare versions, all five compiler commands, runtime
bindings, custom import/store/SQL checks, generated checks and build dry runs
remain unchanged. Four supplemental projects own the maintained files, including
the six `.mjs` implementations with adjacent declarations. All scans are uncached.

The only new native build permission is `unrs-resolver@1.12.2`. Its inspected
postinstall calls `napi-postinstall` to prepare the platform binding, with the
same fallback described in the original evaluation. Both local ARM64 and clean
Linux ARM64 installs executed the approved hook successfully. Strict peers,
strict dependency builds and disabled side-effects caching remain enabled.

## Finding dispositions

| Findings                               | Resolution                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four async HTTP listeners              | A shared fixture server owns handler and stream rejections, sends 500 before headers, and destroys a partial response after headers. Existing fixture-specific diagnostics are retained.                                              |
| Five invalid awaits                    | Remove awaits on synchronous configuration/seed/parser operations and synchronous iterables; retain awaits on streams and async generators.                                                                                           |
| Ingestion readiness return             | Await inside the request's error handler so an unexpected rejection becomes the established problem response.                                                                                                                         |
| Publication and failed-capture returns | Move the returned operations outside the narrower recovery try blocks. An inspection or failure-record write still propagates its own rejection.                                                                                      |
| Four stale deletion-owner returns      | Use the existing lease-loss branch, which waits for the replacement owner outside mutation recovery. No mechanical await routes replacement-owner failures through a stale owner's writes.                                            |
| Collection status switch               | Explicitly group the four active states instead of using a default, preserving current classifications.                                                                                                                               |
| Two floating compiler-contract calls   | Exempt only floating promises in never-executed `test/domain/**/*.types.ts`; compiler checking remains enabled.                                                                                                                       |
| Core diagnostics                       | Remove dead imports/locals and overwritten initializers while preserving effectful calls; retain caught error causes.                                                                                                                 |
| Regex diagnostics                      | Remove ambiguous whitespace overlap in publisher parsers, fix a literal backspace intended as a word boundary in Digimon Q&A, and simplify the two release-contract assertions. Existing parser tests cover retained source behavior. |

Reviewed exceptions are explicit: the `node:test` package's `test` registration
is safe to float, but assertions in its body remain checked; guarded non-null
assertions and numeric interpolation are not style errors; Node's used SQLite API
is allowed; valid empty JSON keys are allowed; the negative undefined-throw test
has a one-line explanation. Two repository import scanners retain their existing
regex with line-local backtracking exceptions because their inputs are maintained
repository source, not publisher or request data. No production Promise operation
is waived or changed to bare `void`.

## Validation

- Local Node 26.8.2, Corepack 0.36.0 and pnpm 12.3.4: frozen install, all five TS7
  projects, focused domain/API/ingestion checks and complete `pnpm run check` pass.
- The retained diagnostic corpus proves 25 selected invalid-case expectations,
  valid controls, all six implementation/declaration cases, runtime globals and
  unsafe flow at the maintained JSON boundary. Faulty examples are parsed only.
- The HTTP regression fails with the old unhandled async listener and passes
  with the shared handler; interrupted request streams also pass. Both are bounded
  Node tests in routine acceptance.
- The Prettier contract proves merge-base committed changes, staged/unstaged edits,
  untracked filenames with spaces, unchanged files and retained/generated exclusions
  in a disposable Git repository. No repository-wide Prettier reformat is committed.
- A fresh `node:26.8.2-bookworm` ARM64 container, with an empty pnpm store, passes
  frozen install, TS7 typechecking, zero-warning ESLint and both tooling contracts.
  Installation took 17.7 seconds, excluding image download/Corepack bootstrap;
  the subsequent frozen install from the same store passed in 86 ms.
  This is Linux container evidence, not GitHub-hosted ready-PR/main evidence.
- The readiness regression reproduces the escaping rejection with the old return
  and verifies the sanitized 500 after the fix. All ten runtime-health tests pass.
- Full routine suite (`pnpm run test:full`): 1,536 tests pass: 298 domain,
  95 API, 788 ingestion and 355 acceptance. Acceptance reports zero failures,
  cancellations or skips. The final complete `pnpm run check` also passes.

## Actual editor results and remaining retirement gates

VS Code's real extension host ran ESLint 3.0.34, Prettier 12.4.0 and TypeScript
native 0.20260708.2. Open Worker files reported discarded D1/R2 operations;
CLI files reported imported Node promises; Vitest and `node:test` reported
unawaited assertions. Format Document produced the configured Prettier output.
ESLint's problem fix action retained the abandoned storage operations and their
diagnostics instead of silently inserting `void`.

Changing an imported function from synchronous to async left the open caller's
typed diagnostics stale, including after Revalidate All Open Files. This matches
the [upstream editor limitation](https://typescript-eslint.io/troubleshooting/typed-linting/#editor-eslint-reports-become-out-of-date-after-file-changes).
Upstream recommends restarting ESLint; the attempted restart did not establish
refreshed caller diagnostics in this verification. The uncached CLI remains the
correctness gate. Do not claim automatic changed-import editor validation.

The native extension initially fell back to its bundled server: its resolver does
not follow the scoped pnpm alias correctly. The configured additional location now
uses the exact pinned pnpm package directory. A separate extension-host run with
that SDK selected in its isolated settings launched the repository
`@typescript/typescript-darwin-arm64/lib/tsc` at 7.0.2 and reported the expected
type error. Developers still select **Use Custom Version** once; computer-use
permissions were unavailable for verifying that picker interaction. Command-line
TS7 selection is verified independently.

Before removing Biome and switching ordinary lint/format tasks, finish the editor
import-refresh/picker check, run full ready-PR CI, review the resulting formatting
changes, and verify resulting main CI. Required CI job identities and shard counts
are preserved. No branch was pushed, PR merged, production operation run, or live
publisher content fetched for this implementation.
