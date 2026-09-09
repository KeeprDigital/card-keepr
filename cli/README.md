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

For isolated remote profiles, pass `--target dev` (or `staging`/`production`).
Profiles use only `KEEPR_<TARGET>_API_KEY` and
`KEEPR_<TARGET>_ADMINISTRATION_KEY` and the canonical environment subdomain;
unscoped credentials and URL overrides are not inherited. Explicit mutation
`--environment` must match the selected target. See
[isolated dev](../docs/runbooks/isolated-dev.md) for provisioning and release gates.

## Source administration

`keepr source registry`, `keepr source authorities`, and `keepr source designate`
inspect shared game/source registrations and explicitly select scoped Source
Authority. See [the request and replay contract](../docs/contracts/source-authority.md).

Source refresh plans fix `participation` (`required` by default, or `optional`)
before collection. Use `source collect --plan-file` to declare several Sources;
a single-plan command also accepts `--participation` and `--subset complete`.
`source registry` lists each adapter's declared complete area. A narrower refresh
is a **new plan** using an independently complete adapter, such as the One Piece
Errata adapter; arbitrary page or set subsets are rejected until an adapter
provides their completeness contract. Retrying a failed plan preserves its scope
and participation. Source selection never transfers Source Authority.

An optional availability outage excludes that whole Source scope from
reconciliation and carries accepted facts forward with a candidate warning.
Its partial snapshots and attempts remain inspectable. Required partial capture,
parser/identity uncertainty, evidence integrity failures, and substantial
unexplained coverage loss block the planned refresh. Capacity, storage retry and
Workflow pauses retain their existing recovery behavior.

`source show --run-id … --json` includes `source_coverage`: the declared scope,
planned/observed request counts, successful check time, underlying content capture
time, latest capture and revalidation counts. Successful checks require complete
reconciled evidence. Failed/partial checks never update successful check times;
publication itself does not make content new. A no-change refresh may verify
unchanged content again. Scope evidence is administration-only.

Use `source lifecycle --lineage …` to inspect source status/history and
`source set-lifecycle --lineage … --state retired --expected-generation 0
--rationale 'Source stopped publishing' --idempotency-key …` for an explicit
retirement. The same command with `--state active` reactivates a Source at its
current generation. Retirement requires idle operations and explicit revision of
any Source Authority designation first; it retains accepted entities and history
and blocks new collection/retry plans. It does not withdraw a Printing.

A complete check may report a Printing no longer observed while retaining its
identity. Explicit withdrawal and later reinstatement are attributable lifecycle
assertions, preserving the same identity and earlier evidence. Conflicting or
out-of-order assertions block reconciliation; absence is never reinstatement.
