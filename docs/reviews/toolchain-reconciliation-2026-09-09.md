# Worker toolchain reconciliation — 9 September 2026

This is the scoped reconciliation for #272, based on reviewed cleanup
`a14a803434dcc7bb150802dad3476989d0f61355` from PR #277. That cleanup is
not yet integrated because existing CI failures remain under #271. The
[original failure ledger](project-cleanup-2026-09-09.md) remains the baseline;
the local logs and their SHA-256 manifest were preserved before this update at
`/tmp/card-keepr-launch-20260909/baseline-before-toolchain`.

## Selected combination

| Component | Locked version | Reason |
| --- | --- | --- |
| Cloudflare Vitest plugin | 1.1.6 | Current replacement for the old Workers pool package. |
| Vitest | 4.1.11 | Latest 4.1 patch; satisfies the plugin's `^4.1.0` peers. Vitest 5 is outside that range. |
| Wrangler | 4.130.0 | Exact dependency of plugin 1.1.6. |
| Direct acceptance Miniflare | 5.20260908.0-alpha | Exact Miniflare release used by both plugin 1.1.6 and Wrangler 4.130.0. |
| workerd | 1.20260908.1 | Exact runtime selected by those upstream releases. |
| TypeScript / Node types | 7.0.2 / 26.1.2 | Retained from the current lockfile. |
| pako types | Bundled with pako 3.0.1 | Removes the obsolete separate type package. |

The Miniflare alpha suffix is intentional and remains visible in the manifest.
Keeping direct acceptance Miniflare 4 while the plugin and Wrangler use 5 would
leave two runtime option contracts and simulator generations in the same
validation run. Instead this update pins the exact upstream pair and validates
the direct harness against it. This does not claim that an alpha is generally
preferable to a stable release, or that a package update resolves application
failures. No Worker compatibility date or production configuration changes.

First-party references checked on 9 September:

- [Cloudflare migration guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/): rename the dependency, imports, and test type entry; the plugin configuration API is retained.
- [Cloudflare setup guide](https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/): Vitest 4.1 or later, with generated Worker declarations and plugin test types.
- [Plugin 1.1.6 release](https://github.com/cloudflare/workers-sdk/releases/tag/%40cloudflare%2Fvitest-plugin%401.1.6), [Wrangler 4.130.0 release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.130.0), and [Miniflare release](https://github.com/cloudflare/workers-sdk/releases/tag/miniflare%405.20260908.0-alpha): exact dependency pairing. Wrangler also fixes quadratic splitting of large local SQL statements, relevant to this repository's retained-evidence fixtures.
- Installed package metadata and declarations confirm the peer ranges, Node
  floor (`>=22` for Wrangler/Miniflare), pako's bundled types, and Miniflare's
  `convertV4MiniflareOptions` export. Wrangler still returns V4 worker options
  and both Wrangler and the plugin use that converter internally.

The repository's Node floor remains `>=22.18`; CI continues to use Node 22.
Local validation uses Node 26.3.0 on macOS arm64 and is recorded separately.

## Preserved patch disposition

The original six-file patch remains unmodified at
`/Users/marcus/Developer/card-keepr-worktrees/preserved-pre-audit-20260909/toolchain.patch`,
with its original files, manifest, and preservation tag
`codex-preserved-pre-audit-20260909`.

- Reapply the package/import/test-type rename to current files, preserving
  current test fixtures, helper imports, stress selection, and test settings.
- Replace the proposed plugin 1.1.4 / Wrangler 4.129.0 pairing with the exact
  release pair above. Keep the patch's Vitest 4.1.11 choice.
- Remove `@types/pako` rather than installing 3.0.0: that release is a deprecated
  stub because the already installed pako 3.0.1 publishes its own declarations.
- Retain Node types 26.1.2. No required Node type incompatibility justifies the
  preserved patch's independent 26.4.1 bump.
- Retain `libsodium-wrappers` 0.7.15 and its resolved runtime dependencies. The
  preserved 0.8.4 upgrade changes a runtime cryptography dependency and has no
  demonstrated need for this toolchain migration. It needs separate behavioral
  assessment if pursued.
- Regenerate the lockfile from the cleanup's current manifest/lockfile using
  package-scoped installation. Do not apply the old lockfile: it predates
  `jsonc-parser`, direct `esbuild`/Miniflare, and current scripts. All current
  runtime dependencies and the corrected #253 stress command remain present.
- Refresh transitive `fast-uri` to 3.1.7 within its existing compatible range.
  Do not accept audit's forced Wrangler/Miniflare downgrade suggestions.

## Validation

The three direct Miniflare entrypoints now convert V4 worker options at the
runtime boundary. The combined harness uses `resourcePersistencePath`, retaining
its existing `miniflare/d1` directory, and receives operational evidence through
`handleStructuredLogs`. Its esbuild bundle already consumes asset rules, so those
rules are not passed again to the runtime converter. No test assertions or
application contracts are relaxed.

The existing curated native validation test first failed with `ERR_VALIDATION`
under Miniflare 5, then passed after conversion. The isolate measurement test
first exposed the removed standard-output callback, then passed using structured
logs. The existing CLI health scenario exposed the converter's rejection of
already consumed module rules, then passed after the boundary fix. These are
toolchain compatibility failures and fixes, separate from the #271 baseline.

The final audit reports four high development package entries, all from the
Cloudflare-pinned `sharp` 0.35.2 dependency and its Miniflare/Wrangler/plugin
dependants ([advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)).
The reported fixed sharp version is 0.35.4; overriding an exact upstream native
dependency is not part of this verified pair. Audit's proposed downgrade to old
Wrangler/Miniflare releases is rejected. `npm audit --omit=dev` reports zero
production vulnerabilities. This is an audit result, not a claim of exploitable
production exposure or a completely clean development dependency tree.

Validation is in progress. The final evidence below will name the implementation
commit, complete suite results, and any unresolved #271 failures; a successful
focused check will not be presented as a successful complete suite.
