# Card Keepr

Card Keepr is a private catalogue service for Bandai Catalogue Data. This first
production spine runs two separately configured Cloudflare Workers:

- `card-keepr-api` is the authenticated read boundary for Catalogue Consumers.
- `card-keepr-ingestion` is the separate administration and mutation boundary.

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
runtimes.

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
access, then starts its durable collection phase explicitly. The registry-bound
adapter version and credential-free HTTPS request are fixed in the plan:

```sh
npm run keepr -- source collect \
  --game one-piece \
  --lineage one-piece-en \
  --adapter one-piece-json-document@1 \
  --request-id cards \
  --url https://www.example.invalid/official/cards.json \
  --idempotency-key source_collection_001 \
  --json

npm run keepr -- source resume --run-id RUN_ID --json
npm run keepr -- source show --run-id RUN_ID
```

An interrupted collection phase resumes against its persisted request plan.
A failed Ingestion Run can only be retried as a new linked Ingestion Run with
`source retry --run-id RUN_ID --idempotency-key NEW_KEY`. A Source Snapshot can
be parsed again without changing its earlier Source Observation set with
`snapshot reparse --snapshot-id SNAPSHOT_ID --adapter one-piece-json-document@2`.

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
  Workflows;
- the numeric GitHub repository, GitHub App, App installation, production
  environment, and credential-boundary workflow IDs.

Replace `CLOUDFLARE_ACCOUNT_ID`, both D1 IDs, and all GitHub numeric IDs in
`apps/ingestion/wrangler.jsonc`. The checked-in GitHub repository ID
`1313489088` is the authoritative ID for `KeeprDigital/card-keepr`; the
App, installation, environment, and workflow values remain `0` until those
resources are provisioned. A zero or non-numeric value intentionally prevents
credential-rotation execution.

Record the GitHub App and installation IDs and resolve the remaining GitHub
IDs. Credential rotation receives the App private key through its secret
descriptor, binds the App ID and SPKI public-key fingerprint in the plan, and
mints a fresh short-lived JWT in memory. The provider queries that exact
installation, requires
selected-repository access and the exact configured permissions, then mints an
installation token scoped to the one configured repository and those same
permissions. Use the minted token to verify the repository, environment,
workflow, and bot actor:

```sh
gh api repos/KeeprDigital/card-keepr --jq .id
gh api installation/repositories \
  --jq '{repository_selection,total_count,repositories:[.repositories[].id]}'
gh api graphql -f query='query { viewer { login } }' --jq .data.viewer.login
gh api repos/KeeprDigital/card-keepr/environments/production --jq .id
gh api repos/KeeprDigital/card-keepr/actions/workflows \
  --jq '.workflows[] | select(.path == ".github/workflows/production-release.yml") | .id'
```

Both the installation and minted token must expose exactly `actions:write`,
`contents:read`, `environments:write`, and `metadata:read`.
`GET /installation/repositories` must return exactly the one configured
repository. The authenticated GraphQL viewer must be the installation's bot
actor; each production release verifies that exact actor. Persisted consumer
slots `a` and `b` map at the GitHub boundary to the serialized
`production-release.yml` workflow's `active` and `replacement` inputs
respectively; a usable proof performs the real API and ingestion Worker
deployment. Cloudflare management tokens
are class-minimal: Worker bearer classes use token read plus Worker-secret
write, D1 classes additionally use token write, and GitHub deployment uses
token read/write without Worker-secret write. Rotated D1 tokens are
account-scoped because
Cloudflare API-token policy resources do not support a D1-database resource
scope; Keepr therefore enforces the exact account, permission, configured
database ID, and request path for every operation. D1 export proof is a
non-mutating metadata read. D1 write proof uses a challenge-owned table in the
configured disposable database and always attempts exact cleanup.

Set `API_BEARER_KEY` only on the API Worker and `ADMINISTRATION_KEY` only on
the ingestion Worker using `wrangler secret put`. Runtime authentication
requires the presented key to remain present in that Worker's live secret
bindings, so provider deletion takes effect even if catalogue finalization
must be reconciled later. Set the production CORS
allowlist to the exact owner origins before deploying. API and administration
bearer replacements use token68 characters and must encode at least 128 bits
(22 characters without padding). Set `CREDENTIAL_CONSUMER_PROOF_KEY` on both
Workers and set `CREDENTIAL_BOUNDARY_ATTESTATION_KEY` only on the ingestion
Worker. Set `GITHUB_APP_ID` to the stable GitHub App ID and
`GITHUB_APP_PRIVATE_KEY` only on ingestion to the App's PEM private key. The
ingestion Worker verifies that stable key fingerprint against the plan, mints
a fresh short-lived App JWT for each observation, verifies the installation's
exact policy, then mints an exact one-repository token. No private key or JWT
plaintext is persisted or returned. Set
`GITHUB_OBSERVATION_ACTOR` to the exact GitHub App bot login that owns those
runs. Set `CLOUDFLARE_OBSERVATION_TOKEN` only on ingestion to an independently
managed observation token with account-token read and Worker-secret metadata
read access. Attestation uses it to verify exact issuer identity and policy,
authoritative old-issuer deletion, exact management-token policy, and the
selected Worker secret name independently of the mutation caller.

The attestation and consumer-proof keys are server-owned and never enter the
CLI or a child process. Credential CLI input is provided through its secret
file descriptor and contains only the credentials needed for the requested
provider mutation. The ingestion Worker issues plan-bound consumer-proof
request tokens; the API and ingestion consumers sign observations that the
caller cannot forge. The CLI passes a validated, versioned plan envelope on a
dedicated descriptor; neither the plan nor its single-use execution capability
appears in child-process arguments. After trusted consumer observations
succeed, ingestion derives the facts itself and issues the final boundary
attestation. Caller-authored provider facts are never signed.
