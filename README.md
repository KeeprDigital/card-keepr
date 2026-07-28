# Card Keepr

Card Keepr is a private catalogue service for Bandai Card data. This first
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

The API Worker has catalogue/evidence/image/export read responsibilities and no
backup binding. The ingestion Worker has the corresponding mutation bindings
plus the private backup bucket. R2 buckets have no `r2.dev` or custom-domain
configuration and remain reachable only through authenticated Worker routes.

Before a first deployment, provision the named APAC D1 database and private R2
buckets, then replace the placeholder D1 identifier in both configurations
with the same real database identifier. Set `API_BEARER_KEY` only on the API
Worker and `ADMINISTRATION_KEY` only on the ingestion Worker using
`wrangler secret put`. Set the production CORS allowlist to the exact owner
origins before deploying.
