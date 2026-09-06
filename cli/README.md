# CLI implementation boundary

The CLI parses arguments, reads proposal files and secret descriptors, asks the
administration runtime to resolve confirmation evidence, and makes HTTP requests.
The ingestion Worker owns production target validation, release-plan
canonicalization and digests. Its release response supplies the exact dispatch
inputs; the CLI forwards them to the fixed GitHub workflow without rebuilding the
plan. Existing command output, confirmations and exit meanings are retained.

`lib/http-client.mjs` is the sole fetch transport for CLI and release tools. It
refuses credential-bearing non-HTTPS URLs except loopback development, refuses
URL credentials, and disables redirects. `lib/json-client.mjs` owns JSON decoding
and Problem-to-exit mapping. Release provider adapters use the same transport for
Cloudflare and GitHub responses. Config reads use `lib/config.mjs` with a JSONC
parser, and descriptor secrets use `lib/secret-input.mjs`.

Administration routes continue returning ordinary JSON documents by default. The CLI requests the
`application/vnd.card-keepr.cli+json` representation, whose envelope supplies the
original document, human text and completion exit code. Target resolution uses
read-only parameters on the existing status route. Production Release previews
use `prepare: true` on the existing release route and do not create preparation
records. Accepted preparation binds the exact confirmation and owner choices;
replaying an idempotency key with changed choices fails.

The deployment workflow can run before a compatible Worker is deployed. Its
named D1 SQL still claims and transfers the production lease, proves live
preflight conditions, and records migration/replacement evidence atomically.
It accepts only the exact server-issued plan bytes and digest recorded in the
immutable preparation ledger. It does not hash or canonicalize locally.
Provider checks independently compare the prepared target with the checked-out
configuration and observed resources before activation.

## Size record for #111

Baseline: `7b5f959c`. Counts include every `.mjs` file recursively under `cli/`,
including all new library modules. The small shared diagnostic-display module
outside `cli/` is also counted below. No client implementation is excluded
because it moved. The unchanged shared runtime-capability declaration is outside
both counts. The full server-only presentation and target-validation modules are
bundled into the Worker and are not imported by the CLI.

| Scope | Before | After |
| --- | ---: | ---: |
| CLI entry point, physical lines | 2,723 | 947 |
| Modules under `cli/`, physical lines | 3,848 | 1,720 |
| Shared diagnostic-display dependency, physical lines | 0 | 14 |
| Total client modules, physical lines | 3,848 | 1,734 |
| Total client modules under the same Biome formatter | 3,337 | 1,734 |

The physical module total fell 54.9%; applying the same formatter to both trees
shows a 48.0% structural reduction, so formatting savings are explicit. The
entry point retains a closed command table and I/O orchestration. Release
scripts retain pre-worker SQL and independent provider attestation; their
transport is shared rather than hidden behind a second request implementation.

Validation covers existing CLI mutation/output contracts, real Worker health
and Curated Revision flows, exact server dispatch bytes, read-only previews,
idempotency conflicts, and D1 rejection of changed plan bytes or digests before
lease acquisition. The obsolete fixture `run start` command is removed with #94;
production collection continues through `source collect`.

## Source administration

`keepr source registry`, `keepr source authorities`, and `keepr source designate`
inspect shared game/source registrations and explicitly select scoped Source
Authority. See [the request and replay contract](../docs/contracts/source-authority.md).
