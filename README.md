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

Before a first deployment, provision the named APAC D1 database and private R2
buckets, then replace the placeholder D1 identifier in both configurations
with the same real database identifier. Set `API_BEARER_KEY` only on the API
Worker and `ADMINISTRATION_KEY` only on the ingestion Worker using
`wrangler secret put`. Set the production CORS allowlist to the exact owner
origins before deploying.
