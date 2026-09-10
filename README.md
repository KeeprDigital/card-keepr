# Card Keepr

Card Keepr is a private, single-owner catalogue for English-language Cards and
Printings across publishers. It serves accepted card facts, printed text and
publisher corrections; tournament eligibility, ban lists, FAQs and rulings are
outside the catalogue ([ADR 0014](docs/adr/0014-card-content-without-tournament-eligibility.md)).
Paid third-party access is deferred until after the private first release.

The implementation includes One Piece, Digimon, Fusion World, Gundam and
Riftbound source adapters, with supplemental One Piece evidence from Limitless.
A game should be enabled for consumers only after its own real-source,
publication and recovery gates pass. Capacity validation and the full isolated
release rollout remain in the [launch backlog](https://github.com/KeeprDigital/card-keepr/issues/216).

Two separately configured Cloudflare Workers serve the catalogue:

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

Contributors and coding agents: read the [testing approach](docs/testing.md)
before selecting checks, adding tests, or changing CI. Start with the
[testing and verification commands](#testing-and-verification) below.

## Local development

Use Node 22.22.2 or newer in the Node 22 line (CI uses Node 22). Corepack
0.35.0 also supports Node 24.15+ and 26+. Install that Corepack release and
enable its pnpm shim; Node 25+ no longer bundles Corepack. The repository pins
pnpm 10.34.5 with Corepack's integrity hash. If Corepack 0.35.0 is already
installed, skip its installation step.

Install dependencies, create the two local secret files, and start both runtimes:

```sh
npm install --global corepack@0.35.0
corepack enable pnpm
node --version
corepack --version
pnpm --version
pnpm install --frozen-lockfile
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/ingestion/.dev.vars.example apps/ingestion/.dev.vars
# Replace both placeholder values with locally generated credentials.
pnpm run db:migrate:local
pnpm run dev
```

Corepack manages pnpm; use your existing Node version manager to select Node.
If a separately installed pnpm shadows Corepack, use `corepack pnpm` in place
of `pnpm` and resolve the PATH conflict in your own environment. Do not force
replacement of global tools. See the [toolchain policy](docs/toolchain.md)
for native dependency permissions, cache behavior and upgrade checks.

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
the first Catalogue Candidate is approved.

Each Worker serves two health routes under its mount (issue #144).

- **Liveness**, `GET /healthz` (`/api/healthz`, `/ingest/healthz`), needs no
  credential and answers `{ "status": "ok", "runtime": "api" | "ingestion" }`
  and nothing else: no version, no bindings, no catalogue facts. It has its
  own per-IP rate limit, separate from the catalogue and administration
  limits, and is not written to the operational request log. Every other
  route still requires its bearer key, and an unknown path under the mount
  still answers `404`. Point external monitors here: a Cloudflare Health
  Check (Traffic → Health Checks) against `https://card.keepr.digital/api/healthz`
  and a second one against `https://card.keepr.digital/ingest/healthz`, method
  `GET`, expecting HTTP `200` and the body `"status":"ok"`, watches both
  mounts without holding a credential.
- **Readiness**, `GET /health`, needs the Worker's bearer key and extends the
  runtime health document with a `checks` block that proves the deployed
  bindings: `database` (a `SELECT 1`, the schema level from
  `catalogue_schema_state`, the current Catalogue Revision pointer, and on
  the ingestion Worker the configured `CATALOGUE_D1_DATABASE_ID`), `objects`
  (a bounded listing of every bound R2 bucket), `workflows` (ingestion only:
  each Workflow binding answers a `get` of an id that never exists with the
  expected not-found error rather than a binding error), `public_base` (the
  configured `PUBLIC_BASE_URL` and whether the request arrived through it),
  and `version` (the deployed Worker version id, tag, and timestamp from the
  `CF_VERSION_METADATA` binding). Any failed check turns `status` to
  `degraded` and the response to HTTP `503`; failures carry a closed reason
  code, never the binding's own error text. The D1 binding does not expose
  its database id at runtime, so `database.configured_database_id` reports
  the var for comparison and the guarded release proves the binding and the
  var agree before activation.

The read-only CLI health check reads readiness on both runtimes, prints the
checks, and exits non-zero when either runtime is degraded. It takes
credentials only from the environment, never from command arguments:

```sh
export KEEPR_API_KEY='...'
export KEEPR_ADMINISTRATION_KEY='...'
pnpm run keepr health
pnpm run keepr health --json
```

Override `KEEPR_API_URL` and `KEEPR_INGESTION_URL` when inspecting deployed
runtimes. Both are base URLs that include the mount path
(`https://card.keepr.digital/api` and `https://card.keepr.digital/ingest`);
the CLI appends route paths to them.

Catalogue Candidates are prepared independently per Supported Game from retained
Source evidence and recorded owner decisions. Inspection covers the complete
candidate. Publication approval binds its manifest, expected Game Catalogue
Revision and generation; durable preparation and a verified backup checkpoint
precede the atomic composition switch. Test-only synthetic adapters remain in
`test/support` and are absent from shipped Workers.

Start with the installed source registry and the documented owner journeys:

```sh
pnpm run keepr source registry --json
pnpm run keepr game-candidate list --run-id RUN_ID --json
pnpm run keepr game-candidate inspect --candidate-id CANDIDATE_ID --json
```

The [One Piece two-source runbook](docs/runbooks/one-piece-two-source.md) explains
source scopes and explicit admission decisions. Follow
[bounded reconciliation](docs/runbooks/bounded-reconciliation.md),
[publication preparation](docs/runbooks/publication-preparation.md), and
[atomic game publication](docs/runbooks/atomic-game-publication.md) to inspect,
approve and observe a native publication. Collection, candidate, publication and
backup IDs identify different operations. The legacy run-approval route still
exists for its remaining callers; their migration is tracked in
[#274](https://github.com/KeeprDigital/card-keepr/issues/274).

An interrupted collection phase resumes against its persisted request plan.
A run that reaches its Source Adapter Version's request capacity, exhausts
recoverable transport or R2 retries, or loses its collection Workflow pauses
instead of failing: `source show` reports the pause reason and the exact
actions available. Extend a capacity-paused run with
`source capacity extend --run-id RUN_ID --expected-capacity 15000
--expected-generation 1 --capacity 20000 --idempotency-key KEY`, then
`source resume --run-id RUN_ID` continues the same run from its retained
evidence. Stop a collecting run deliberately with
`source pause --run-id RUN_ID --idempotency-key KEY`, which pauses it with
the reason `owner_requested`, then abandon the paused run with
`source terminate --run-id RUN_ID --idempotency-key KEY`; termination keeps
every retained Source Snapshot and diagnostic, marks the run terminal, and
releases the active-run reservation. See
`docs/runbooks/collection-pause.md`.
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
pnpm run keepr catalogue search repair \
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

Curated Revisions are administered through the authenticated ingestion
routes under `/admin/v1/curated-revisions` and the matching
`keepr curated-revision` commands. In those routes, commands, and
`src/catalogue/curated/curated-revisions.ts`, the request field `proposal` (with
`--proposal`, `proposal_digest`, and the retained `proposal_json` column) is
the short form of the Curated Revision Proposal defined in `CONTEXT.md`: the
owner-authored request that becomes a Curated Revision only when created
exactly as validated. It is never a Curated Revision itself.

```sh
pnpm run keepr curated-revision validate \
  --proposal proposal.json \
  --expected-current-revision CURRENT_CATREV_ID \
  --json

pnpm run keepr curated-revision create \
  --proposal proposal.json \
  --proposal-digest PROPOSAL_SHA256 \
  --expected-current-revision CURRENT_CATREV_ID \
  --idempotency-key curated_001 \
  --environment production \
  --confirm "$PRODUCTION_TARGET" \
  --yes \
  --json

pnpm run keepr curated-revision list --game one-piece --status active
pnpm run keepr curated-revision show --revision-id CURATED_REVISION_ID
```

`validate` posts the proposal to
`POST /admin/v1/curated-revisions/validate` and returns its canonical
`proposal_digest`; `create` posts the same proposal and digest to
`POST /admin/v1/curated-revisions`, and fails closed unless the digest, the
current Catalogue Revision, and the reviewed Official Source state still
match. `reaffirm`, `supersede`, and `retire` post to
`POST /admin/v1/curated-revisions/{id}/{operation}`; only `supersede` takes
a replacement `--proposal` and `--proposal-digest`, and that proposal must
name the exact prior Curated Revision in `supersedes_revision_id`. Pass
`--proposal -` to read the proposal from stdin.

The parent Cloudflare Workflow dynamically starts one child Workflow per
Official Source hostname. Requests for a hostname are sequential and durably
paced, while different hostname shards can progress concurrently.

Exact successful response bytes and Source Observation documents are retained
without automatic deletion in the private evidence R2 bucket. D1 keeps their
digests and immutable provenance references. Redirects and failed requests are
retained as diagnostics only. Authenticated content routes stream retained
objects at `/v1/source-snapshots/{id}/content` and
`/v1/source-observation-sets/{id}/content`.

## Testing and verification

```sh
pnpm run check
pnpm test
```

`pnpm run check` runs lint, changed-file formatting checks, TypeScript checks,
generated-file checks, import rules and both Worker build dry runs. It leaves
tests to `pnpm test`. See the [command reference](docs/commands.md) for every
command, its scope and the renamed commands.

`pnpm test` is the fast everyday check: domain tests, API Worker tests, and small
external CLI / native publication-and-restore smoke tests. Use
the affected integration file for focused feedback while changing ingestion.
Before marking a PR ready, run `pnpm run test:full` when practical, or use the
ready-PR CI run for the full result; it adds all ingestion integration
and routine acceptance tests. CI runs quick checks on drafts and full regression
checks on ready PRs and pushes to `main`, with three shards for each large suite.

Full catalogue journeys (`pnpm run test:acceptance:extended <scenario>`) and benchmarks
(`pnpm run test:benchmark <scenario>`) are separate investigations.
`pnpm run test:stress` runs the small weekly pacing checks;
`pnpm run test:stress:full` explicitly selects all Worker capacity tests. The normal checks have no
6 GiB disk-space requirement. See [the testing guide](docs/testing.md) for the
commands, coverage, budgets, CI triggers, and rules for adding tests.

When updating test dependencies, keep Vitest within the Cloudflare plugin's
declared peer range. The current plugin supports Vitest 4.1, not Vitest 5.

Pull requests and `main` run these checks without production credentials or
remote mutation. Production changes are dispatched only by the guarded
`keepr release production` command into the serialized, protected GitHub
workflow. See [the Production Release runbook](docs/runbooks/production-release.md)
for confirmation bindings, versioned deployment, smoke checks, compatible
roll-forward, and replacement-D1 handoff. See the
[backup and recovery runbook](docs/runbooks/backup-recovery.md) for post-publication
restore proof, backup retries, and owner-accepted Catalogue Recovery.

Binding declarations live in each runtime's `wrangler.jsonc`; generated
`worker-configuration.d.ts` files are checked in and must be regenerated after
binding changes with `pnpm run generate:worker-types`.

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
matching `*_REPLACEMENT` key as a second valid bearer, so a key can be changed
without a gap; both slots must hold a value because the guarded Production
Release verifies the secret inventory. Set `D1_EXPORT_TOKEN` and
`D1_VERIFICATION_TOKEN` only on ingestion. Set the production CORS allowlist to
the exact owner origins before deploying. API and administration bearer keys
use token68 characters and must encode at least 128 bits (22 characters
without padding).
