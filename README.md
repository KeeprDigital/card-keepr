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
npm run dev
```

The API listens on `http://127.0.0.1:8787` and ingestion listens on
`http://127.0.0.1:8788`. Local D1 and R2 state is emulated by Wrangler.
`GET /v1/catalogue` provides the schema-valid walking-spine document identified
by `catrev_spine_000`; the later publication path will replace these configured
bootstrap values with the current Catalogue Revision from D1.

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

The API Worker has catalogue and Printing Image read responsibilities and no
evidence, export-mutation, or backup binding. The ingestion Worker has the
corresponding mutation bindings plus the private backup bucket. R2 buckets have
no `r2.dev` or custom-domain configuration and remain reachable only through
authenticated Worker routes.

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
