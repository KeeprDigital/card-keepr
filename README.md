# Card Keepr

Card Keepr is a private catalogue service for Bandai Catalogue Data. This first
production spine runs two separately configured Cloudflare Workers:

- `card-keepr-api` is the authenticated read boundary for Catalogue Consumers,
  served at `https://card.keepr.digital/api`.
- `card-keepr-ingestion` is the separate administration and mutation boundary,
  served at `https://card.keepr.digital/ingest`.

Both Workers share one host through zone routes on `keepr.digital` (ADR
0007). Each `wrangler.jsonc` declares the Worker's public base in
`PUBLIC_BASE_URL`; the path of that URL is the mount every request must sit
under, and every link the API emits is an absolute URL built from it. The
health routes are therefore `https://card.keepr.digital/api/health` and
`https://card.keepr.digital/ingest/health`, and `/v1/...` routes sit under
the same prefixes. Requests outside a mount receive `404` before
authentication.

## Local development

Install dependencies, create the two local secret files, and start both
runtimes:

```sh
npm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/ingestion/.dev.vars.example apps/ingestion/.dev.vars
# Replace both placeholder values with locally generated credentials.
npm run db:migrate:local
npm run dev
```

The API listens on `http://127.0.0.1:8787` and ingestion listens on
`http://127.0.0.1:8788`. Local D1 and R2 state is emulated by Wrangler.
The copied `.dev.vars` files set `PUBLIC_BASE_URL` to those local origins,
which mounts each Worker at its root locally (`.dev.vars` overrides the
production value in `wrangler.jsonc`, as does `wrangler dev --var
PUBLIC_BASE_URL:...`). Without that override the local Worker would expect
the production mount path, for example `http://127.0.0.1:8787/api/health`.
`migrations/` starts from a single schema baseline, `0001_baseline.sql`,
which creates the whole schema and its seed rows at schema level 1 (ADR
0006); every later migration opens with a schema-level guard and bumps the
level by one.
`GET /v1/catalogue` reads the current Catalogue Revision pointer from D1. A new
database starts at the schema-valid `catrev_spine_000` bootstrap pointer until
the first controlled fixture is approved.

The read-only CLI health check takes credentials only from the environment,
never from command arguments:

```sh
export KEEPR_API_KEY='...'
export KEEPR_ADMINISTRATION_KEY='...'
npm run keepr -- health
npm run keepr -- health --json
```

Override `KEEPR_API_URL` and `KEEPR_INGESTION_URL` when inspecting deployed
runtimes. Both are base URLs that include the mount path
(`https://card.keepr.digital/api` and `https://card.keepr.digital/ingest`);
the CLI appends route paths to them.

The first controlled publication can be exercised without Official Source
network access:

```sh
npm run keepr -- run start \
  --fixture first-catalogue \
  --games one-piece \
  --idempotency-key ingestion_fixture_first_001 \
  --json

npm run keepr -- run show --run-id RUN_ID --json
npm run keepr -- candidate inspect --run-id RUN_ID --json

npm run keepr -- run approve \
  --run-id RUN_ID \
  --candidate-digest CANDIDATE_SHA256 \
  --expected-current-revision CURRENT_REVISION_ID \
  --idempotency-key approval_fixture_first_001 \
  --yes \
  --json
```

Approval fails closed unless the run identity, candidate digest, and current
Catalogue Revision still match. Publication verifies the deterministic
Catalogue Export before atomically advancing the D1 current-revision pointer.

An Ingestion Run persists its Official Source evidence plan before any network
access, then starts its durable collection phase explicitly. Production JSON
Card adapters remain unavailable until an exact Bandai Card-list surface is
implemented. The installed production Errata adapter is fixed to Bandai's
exact English Errata URL:

```sh
npm run keepr -- source collect \
  --game one-piece \
  --lineage one-piece-en \
  --adapter one-piece-official-errata-html@1 \
  --request-id errata \
  --url https://en.onepiece-cardgame.com/rules/errata_card/ \
  --idempotency-key source_collection_001 \
  --json

npm run keepr -- source resume --run-id RUN_ID --json
npm run keepr -- source show --run-id RUN_ID
PRODUCTION_TARGET="$(npm run --silent keepr -- status --json | jq -c .production_target)"
npm run keepr -- run reconcile \
  --run-id RUN_ID \
  --expected-current-revision CATREV_ID \
  --idempotency-key reconcile_RUN_ID \
  --environment production \
  --confirm "$PRODUCTION_TARGET" \
  --yes \
  --json
```

An interrupted collection phase resumes against its persisted request plan.
A run that reaches its Source Adapter Version's request capacity, exhausts
recoverable transport or R2 retries, or loses its collection Workflow pauses
instead of failing: `source show` reports the pause reason and the exact
actions available. Extend a capacity-paused run with
`source capacity extend --run-id RUN_ID --expected-capacity 15000
--expected-generation 1 --capacity 20000 --idempotency-key KEY`, then
`source resume --run-id RUN_ID` continues the same run from its retained
evidence. Abandon a paused run deliberately with
`source terminate --run-id RUN_ID --idempotency-key KEY`; termination keeps
every retained Source Snapshot and diagnostic, marks the run terminal, and
releases the active-run reservation.
A failed Ingestion Run can only be retried as a new linked Ingestion Run with
`source retry --run-id RUN_ID --idempotency-key NEW_KEY`. A Source Snapshot can
be parsed again without changing its earlier Source Observation set with
`snapshot reparse --snapshot-id SNAPSHOT_ID --adapter one-piece-en@6`. Only
the exact capturing version may reparse a snapshot; an unregistered version
is refused with `adapter_not_supported`.
Reconciliation is an authenticated owner action. Before sending the mutation,
the CLI resolves the named production Ingestion Run, its bound Catalogue
Revision, and the exact Cloudflare account, Worker scripts, D1 databases, and
R2 buckets returned by production status. `--confirm` must equal that complete
resolved target document; absent or altered confirmation performs no mutation
and exits `3`. A stale resolved run, Catalogue Revision, or retained repair
target exits `7`; exit `2` is reserved for malformed usage. An accepted
Workflow that is not yet terminal exits `10`; a Workflow that completes during
the initial POST and every terminal replay return HTTP `200` and exit `0`.

After applying a migration that changes the search projection to a database
that already contains Catalogue Revisions, run the bounded, idempotent search
repair until its JSON response reports `"complete": true`:

```sh
npm run keepr -- catalogue search repair \
  --target-revision CATREV_ID \
  --expected-current-revision CURRENT_CATREV_ID \
  --idempotency-key repair_CATREV_ID \
  --environment production \
  --confirm "$PRODUCTION_TARGET" \
  --yes \
  --json
```

Card search repair is limited to the authoritative retained chain returned by
production status: the current Catalogue Revision and its two immediate
predecessors. It does not infer that chain from the bounded recent-run
diagnostics, and it never advertises the unpublished bootstrap spine. Run the
command again with a new idempotency key for each bounded step until it reports
`"complete": true`. Legacy revisions outside that retained window stay
archived and cannot be repaired. A legacy Card whose retained JSON exceeds the
durable 65,536-byte UTF-8 source bound fails with HTTP `422` before the repair
request is retained or search materialization begins. Newly published revisions
write their selective literal n-gram search material and availability marker
atomically. Each repair invocation completes up to 25 Cards through
CAS-guarded batches of at most 500 search entries plus one cursor statement,
with a 20-second cooperative invocation budget and a 65,536-byte per-statement
parameter bound.

The parent Cloudflare Workflow dynamically starts one child Workflow per
Official Source hostname. Requests for a hostname are sequential and durably
paced, while different hostname shards can progress concurrently.

Exact successful response bytes and Source Observation documents are retained
without automatic deletion in the private evidence R2 bucket. D1 keeps their
digests and immutable provenance references. Redirects and failed requests are
retained as diagnostics only. Authenticated content routes stream retained
objects at `/v1/source-snapshots/{id}/content` and
`/v1/source-observation-sets/{id}/content`.

## Verification

```sh
npm run types:check
npm run typecheck
npm test
npm run deploy:dry-run
```

`npm test` runs three layers. `test:domain` is plain node Vitest over
`test/domain/`: parsers, reconciliation identity, legality, export, and
contract checks that import `src/catalogue` directly and finish in about a
second. `test:workers` runs `apps/*/test` inside the Workers pool with D1,
R2, and Workflows bindings. `test:acceptance` boots real `wrangler`
processes for `acceptance/`. A new test belongs in the lowest layer that can
express it.

Pull requests and `main` run these checks without production credentials or
remote mutation. Production changes are dispatched only by the guarded
`keepr release production` command into the serialized, protected GitHub
workflow. See [the Production Release runbook](docs/runbooks/production-release.md)
for confirmation bindings, versioned deployment, smoke checks, compatible
roll-forward, and replacement-D1 handoff.

Binding declarations live in each runtime's `wrangler.jsonc`; generated
`worker-configuration.d.ts` files are checked in and must be regenerated after
binding changes with `npm run types:generate`.

The API Worker has catalogue, Printing Image, and Catalogue Export read
responsibilities and no evidence, export-mutation, or backup binding. The
ingestion Worker has the corresponding mutation bindings plus the private
backup bucket. R2 buckets have no `r2.dev` or custom-domain configuration and
remain reachable only through authenticated Worker routes.

Cloudflare D1 and R2 bindings are resource-scoped rather than method-scoped, so
the API's least-privilege boundary is the smaller attached resource set plus its
read-only routes and separate bearer credential. Evidence, Catalogue Export,
backup, and administration capabilities are attached only to ingestion.

Before a first deployment, provision and record every production target rather
than reusing the checked-in Cloudflare placeholders:

- the Cloudflare account ID;
- `card-keepr-api` and `card-keepr-ingestion` Worker scripts;
- the APAC `card-keepr-catalogue` D1 database and a separate disposable
  verification D1 database;
- the private `card-keepr-evidence`, `card-keepr-printing-images`,
  `card-keepr-catalogue-exports`, and `card-keepr-backups` R2 buckets;
- the `card-keepr-evidence-ingestion` and `card-keepr-evidence-host`
  Workflows.

Replace `CLOUDFLARE_ACCOUNT_ID` and both D1 IDs in
`apps/ingestion/wrangler.jsonc`.

Set `API_BEARER_KEY` only on the API Worker and `ADMINISTRATION_KEY` only on
the ingestion Worker using `wrangler secret put`. Each Worker also accepts the
matching `*_REPLACEMENT` key so a rotation never has a gap; rotate either key
by the dual-key procedure in `docs/runbooks/credential-rotation.md`. Set
`D1_EXPORT_TOKEN` and `D1_VERIFICATION_TOKEN` only on ingestion. Set the
production CORS allowlist to the exact owner origins before deploying. API and
administration bearer replacements use token68 characters and must encode at
least 128 bits (22 characters without padding).
