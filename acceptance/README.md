# Acceptance tiers

`npm run test:acceptance` runs both tiers. CI retains the three existing
`acceptance` shards; `npm run test:acceptance:shard -- --shard=1/3` runs one locally.
Tests use retained source bytes and local services. Ordinary acceptance does not
fetch live publisher pages.

## Wrangler smoke

`npm run test:acceptance:smoke` runs the five flows listed in
`helpers/smoke-tier.mjs`. They retain real Wrangler subprocess startup, bindings,
D1 migrations, Workflow execution, public HTTP and CLI behavior:

| File | Coverage |
| --- | --- |
| `one-piece-catalogue.test.mjs` | `one-piece-en` collection, approval, publication and consumer reads |
| `fusion-world-catalogue.test.mjs` | `fusion-world-en` collection, approval, publication and consumer reads |
| `digimon-catalogue.test.mjs` | `digimon-en` collection, approval, publication and consumer reads |
| `gundam-catalogue.test.mjs` | `gundam-en-asia` and `gundam-en-us`, including shared Card/Printing provenance across the two lineages |
| `source-evidence-cli.test.mjs` | The external CLI's retained-evidence audit contract against an ingestion Worker |

There are **five flows covering five official Source Lineages plus the CLI**.
Gundam deliberately remains a joint regional flow. The coverage test compares
this list with the shipped authority registry, so adding a lineage requires an
explicit smoke decision. Smoke source providers return retained official bytes;
the source adapters and public administration/consumer contracts remain real.

## In-process runtime and contract tests

`npm run test:acceptance:runtime` runs everything outside that explicit smoke list.
Eight Worker-backed files now use a programmatic Miniflare combined runtime:
`catalogue-publication`, `contextual-legality`, `curated-revision-source-changes`,
`errata-runtime`, `official-source-adapter-cli-failures`,
`operational-diagnostics-leak`, `product-catalogue`, and `runtime-health`.
The remaining contract tests retain their existing Node/SQLite/provider seams.

The runtime helper reads the checked-in or test-specific Wrangler configuration,
bundles its entrypoint once per test process, and composes the API, ingestion and
source services in one Miniflare instance per test directory. Workerd supplies
real D1, R2, Workflow, rate-limit and service bindings. A local HTTP bridge lets
the unchanged CLI subprocesses and HTTP assertions exercise those Workers.
The bridge forwards request headers inside a service call so malformed browser
origins reach the application's CORS validation. It preserves the local origin,
which the readiness assertions check explicitly.

Migrations and SQL seeding use the D1 binding directly. State identities include
the supplied `statePath`: equal paths share D1/R2, distinct paths remain isolated,
and a restart reopens persisted data. Provider services may start after their
consumers; calls before the provider starts fail with HTTP 503. The final handle
closes the whole runtime. Operational logs remain available to leak/correlation
assertions. Polling reserves 20% of the actual configured administration budget;
fixture configs already allowing 300 requests/minute use 250ms while smoke and
production 30/minute bindings retain 2500ms. Test fixture composition lives in
test-owned entrypoints and harnesses.

## Measured wall time

The comparison uses the same three CI-shard commands, run sequentially on the
same local macOS arm64 host (Node 26.3.0) on 2026-09-04, with dependencies installed and the existing
Wrangler migration-template cache. Each shard still runs its files concurrently.
Times exclude installation and GitHub runner provisioning; these are local
measurements, not claimed CI timings. The baseline is commit `7b5f959c`.

| CI shard command | Before (seconds) | After (seconds) |
| --- | ---: | ---: |
| `--shard=1/3` | 38.942 | 38.567 |
| `--shard=2/3` | 104.156 | 44.691 |
| `--shard=3/3` | 41.775 | 25.281 |
| Sum | 184.873 | 108.539 |
| Slowest shard | 104.156 | 44.691 |

The sum fell **41.3%**; the slowest shard fell **57.1%**. Every shard passed:
174 tests before, 179 after (three offline recapture cases, smoke coverage, and
fixture polling added). No existing flow was removed. Polling time includes real
Workflow completion and respects each fixture's configured request budget.
The [measurement record](timings/2026-09-04.json) contains commits, commands,
counts, environment and methodology. Workerd startup and timing-window-dependent
rate-limit probes can vary between runs; these are one complete before/after pair.

## Live-source freshness

The independent weekly [recapture workflow](../.github/workflows/official-source-recapture.yml)
checks retained digests against current publisher responses and fails on drift.
It retains the changed bytes/report and opens or updates a GitHub issue; it never
automatically replaces goldens. See the [retained-byte procedure](fixtures/retained-official-source/README.md)
for review, manual dispatch, cadence, and the monthly liveness check required by
GitHub's 60-day scheduled-workflow inactivity rule.
