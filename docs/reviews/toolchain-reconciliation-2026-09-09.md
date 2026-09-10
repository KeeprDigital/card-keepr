# Worker toolchain reconciliation — 9 September 2026

Historical proposal and validation evidence. The selected 10 September baseline
and the preserved patch's final disposition are recorded in
[the cleanup evidence](../evidence/private-launch-cleanup-20260910.md#current-toolchain-disposition).
The version table below describes this earlier attempt, not the current manifest.

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

Implementation commit: `0b4b41ddc6be9501a6e810e83c3e6955fba55741`.
The complete default selection runs its phases sequentially, including later
phases after an earlier failure. The host has one heavy-test lease. No runtime
configuration, test assertion, or per-test timeout changes during this run.

| Check | Result |
| --- | --- |
| Lockfile installation and dependency tree | Passed; runtime dependency lock entries unchanged. |
| Type generation/check, typecheck | Passed on Node 26.3.0; typecheck also passed on Node 22.23.2. |
| Lint, changed-file formatting, whitespace | Passed; 30 existing warning and 24 info diagnostics remain. |
| Catalogue cycles/boundary, document validators | Passed. |
| Both deployment dry runs | Passed; no deployment. |
| Focused API health / source intake | 9/9 and 13/13 passed. |
| Focused native validation / isolate metrics / combined CLI health | 2/2 and 1/1 passed after the compatibility fixes. |
| Complete domain | 246/246, 44 files, 3.251 seconds including command startup. |
| Complete API | 95/95, 13 files, 13.134 seconds including command startup. |
| Complete ingestion | 736 passed, 17 failed, 88 files, 428.981 seconds; exit 1, no interruption. |
| Complete acceptance | 343 passed, 2 failed, 1 opt-in skip across all 346 tests and 68 files; 2,623.437 seconds; exit 1, no interruption. |

The outer validation bounds are 5 minutes for domain, 20 for API (the combined
checks job), 36 for ingestion (three 12-minute CI shards), and 90 for the serial
acceptance selection. The acceptance bound includes the prior 2,128-second partial
run and the retained Riftbound scenario's four separate 600-second waits plus
its 120-second publication/backup waits. No individual Riftbound scenario is
stopped at the previous 10m58s cutoff. Exceeding a bound is an interrupted check,
never a passing assertion. Existing per-request and per-test bounds remain intact.

Raw local logs, exact command arrays, timing and exit status are under
`/tmp/card-keepr-launch-20260909/issue-272-full`; focused/static logs use the
`issue-272-*` prefix in the parent directory. These local files are diagnostic
artifacts, not durable Actions evidence. PR #279's CI is separate and remains
subject to all required checks.
The completed phase logs, command metadata and failure inventory are hashed in
`issue-272-full/validation-manifest.json` beside those local artifacts.

## Complete ingestion failure ledger

Ten failures have the same test names as the original cleanup ledger; seven
other names failed in this suite context. Matching names alone do not establish
an identical cause, and original failures absent here are not certified fixed.
The coordinator owns classification and regression fixes in #271.

- `apps/ingestion/test/evidence-cleanup.spec.ts`: owner reclaims a positively inventoried abandoned preparation orphan without traversing shared roots. Same name in the original baseline.
- `apps/ingestion/test/evidence-cleanup.spec.ts`: a conclusively deleted staging key can hold the same bytes for a new preparation; old delete tickets cannot cross incarnations. Same name in the original baseline.
- `apps/ingestion/test/evidence-cleanup.spec.ts`: an ambiguous staging deletion keeps its ticket open and prevents reuse despite another HEAD showing absence. Same name in the original baseline.
- `apps/ingestion/test/evidence-cleanup.spec.ts`: an unrelated staging key progresses while a prior delete outcome remains unknown. Same name in the original baseline.
- `apps/ingestion/test/evidence-cleanup.spec.ts`: concurrent conflicting staging starts cannot silently share an idempotency key. Same name in the original baseline.
- `apps/ingestion/test/game-reconciliation-operations.spec.ts`: a native source change retains reconfirmable curated diagnostics without failing the collection. Same name in the original baseline.
- `apps/ingestion/test/identity-corrections.spec.ts`: reviewed known-number merge preserves a source Printing through corrected evidence and subsequent refresh. Additional failure in this suite context.
- `apps/ingestion/test/identity-corrections.spec.ts`: new Printing discovered after a Card split can receive an append-only owner assignment. Additional failure in this suite context.
- `apps/ingestion/test/identity-corrections.spec.ts`: reviewed identity application prepare through durable bounded groups. Same name in the original baseline.
- `apps/ingestion/test/identity-corrections.spec.ts`: reviewed identity lookup prepare through durable bounded groups. Same name in the original baseline.
- `apps/ingestion/test/reconciliation-card-identity.spec.ts`: Gundam EN-ASIA and EN-US evidence converges on one Printing while substantive conflict blocks. Additional failure in this suite context.
- `apps/ingestion/test/reconciliation-card-identity.spec.ts`: historical Gundam locators survive disappearance without retaining stale Card authority. Additional failure in this suite context.
- `apps/ingestion/test/reconciliation-export-and-repair.spec.ts`: publication rejects an over-budget candidate before writing any immutable object. Additional failure in this suite context.
- `apps/ingestion/test/reconciliation-progress.spec.ts`: a published catalogue larger than 1 MiB is streamed into the next candidate without an aggregate prior-payload read. Additional failure in this suite context.
- `apps/ingestion/test/reconciliation-provenance-locators.spec.ts`: locator variant evolution preserves effective-dated suffix history across disappearance and reactivation. Additional failure in this suite context.
- `apps/ingestion/test/reconciliation-workflow-binding.spec.ts`: parsed observation count warnings use the normative absolute threshold. Same name in the original baseline.
- `apps/ingestion/test/source-refresh-publication.spec.ts`: unexplained substantial coverage loss blocks completeness rather than becoming ordinary disappearance. Same name in the original baseline.

The observed symptoms are five cleanup-guard/failed-intent consequences, seven
test timeouts, one immutable evidence object collision, three reconciliation
polling deadlines, and one source run still parsing. The #271 lane must
reproduce these in context; the toolchain upgrade does not resolve them by
itself. Stress remains the separate corrected `test:stress` selection under #253.

## Complete local acceptance evidence

The serial selection finished naturally at implementation head `0b4b41dd`,
from `2026-09-09T09:10:51.041884Z` to `2026-09-09T09:54:34.511011Z`.
Node reported 2,623.349 seconds; the command including startup took 2,623.437
seconds. There were zero cancellations. The one skipped test is the separately
opted-in synthetic Product capacity probe; this is not a capacity measurement.

Both failing tests returned an administration HTTP 429:

- `composed-recovery.test.mjs`: native owner publication Workflow verifies recovery with retained composition, 46.148 seconds. `waitBackup` failed at line 857, called from `proveNativeComposition` at line 907. The runtime failure log and retained state remain at `/var/folders/h9/r2hp35sx2bs4v69vcsxsls900000gn/T/card-keepr-native-preparation-r3nK4i/failure-runtime.log`.
- `product-catalogue.test.mjs`: the CLI publishes separated Product catalogue data consumed through authenticated HTTP, 56.740 seconds. `inspectNativeCollection` received 429 instead of 200 through `native-catalogue-runtime.mjs:96`, called at `product-catalogue.test.mjs:495`. This fixture's existing unconditional teardown removes its temporary state; the complete failure stack is retained in the suite log. No unpublished runtime state is claimed as available evidence.

The #271 lane owns reproduction and request-pacing fixes. These final stacks
establish the local failures' symptoms; they do not establish that the remote
Product candidate-preparation failure has the same cause.

The longest retained scenarios completed without relaxing their deadlines:

| Scenario | Passed duration |
| --- | --- |
| Full retained Riot inventory, Errata and Products, publication and actual SQL restore | 1,151.255 seconds |
| Retained P-001 two-source One Piece journey | 663.772 seconds |
| Native One Piece publication and backup | 119.069 seconds |
| Five-game current-plus-two backup and actual SQL import | 65.577 seconds |
| Bounded Riftbound actual SQL restore | 24.797 seconds |
| Retained source-evidence CLI journey | 17.779 seconds |

The full Riot scenario used a fresh retained collection: 14 initial snapshots,
15 journey snapshots, 1,260 observations, 1,189 inventory records, 31 initial
Errata observations and nine Products. It included six visually reviewed
Printings and 30 additional Card-only admissions, with 1,183 intentional
unretained-image failures. Its disk preflight reported 15,154,978,816 bytes free.
This proves the existing bounded functional journey, not full-image coverage or
production capacity. All three planned publications and backups were verified,
including restored consumer and export checks.

The host lease was released only after the driver exited and no acceptance
process or workerd remained. The complete local selection is still failed;
independent reviews and individual passing journeys do not remove that gate.

## Pull request CI

[PR #279 run 34331767421](https://github.com/KeeprDigital/card-keepr/actions/runs/34331767421)
completed naturally against implementation head `0b4b41dd` with an overall failed
result. Its Node 22 Linux runner results are distinct from the serial local run.
Lint, domain tests and the combined typecheck, generation, boundary, document,
API and deployment-dry-run checks passed.

| CI selection | Result | Test duration |
| --- | --- | --- |
| Ingestion shard 1 | 246 passed, 7 failed | 343.89 seconds |
| Ingestion shard 2 | 242 passed, 7 failed | 457.17 seconds |
| Ingestion shard 3 | 250 passed, 1 failed | 489.64 seconds |
| Acceptance shard 1 | 109 passed, 1 opt-in skip | 189.233 seconds |
| Acceptance shard 2 | 75 passed, 5 failed | 1,048.454 seconds |
| Acceptance shard 3 | 156 passed | 1,018.429 seconds |

The complete CI ingestion selection therefore reports 738 passed and 15 failed;
acceptance reports 340 passed, 5 failed and 1 opt-in skip. No job was cancelled.
The acceptance shard runner uses Node's default file concurrency, while the
local complete selection explicitly runs one file at a time. These are separate
suite contexts, not interchangeable green/red comparisons.

All five acceptance failures were in shard 2:

- `one-piece-catalogue.test.mjs`: backup remained `exporting` at its existing polling deadline; runtime logs include a broken pipe, cancelled requests and a D1 operation failure.
- `product-catalogue.test.mjs`: game candidates remained `preparing` at the existing polling deadline.
- `publication-preparation.test.mjs`: the native artifact preparation assertion failed after 46.578 seconds.
- `riftbound-catalogue.test.mjs`: candidate preparation reached its existing polling deadline after 960.579 seconds for the scenario. This was a natural failure, not the earlier coordinator interruption.
- `source-evidence-cli.test.mjs`: retained evidence reached `awaiting_approval`, but its parent Workflow remained `running` at the existing polling deadline.

Raw job logs are retained locally as
`/tmp/card-keepr-launch-20260909/issue-272-ci-{ingestion,acceptance}-{1,2,3}.log`.
The linked Actions run is the durable evidence. Cause classification and fixes
remain with #271; this result does not certify the upgrade or the release green.

## Independent review

Two read-only review axes used fixed base
`a14a803434dcc7bb150802dad3476989d0f61355` and implementation head
`0b4b41ddc6be9501a6e810e83c3e6955fba55741`.

### Standards

The independent source-recapture agent reported zero hard documented-standard
violations and zero actionable smells. The review covered the scoped package,
generated-type and acceptance compatibility changes against the repository rules.

### Spec

The independent fixture/census agent reported zero code findings against #272.
The complete-suite acceptance gate was explicitly still pending; the review did
not call unresolved suite failures green or authorize integration without checks.
