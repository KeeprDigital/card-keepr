# Credentials

One inventory of every credential the system uses, per environment and per
consumer, derived from the code that uses it. It records names, permission
sets, scope, where each value lives, and how to rotate; it never records a value.
[Issue #387](https://github.com/KeeprDigital/card-keepr/issues/387) owns the
dashboard reconciliation; [issue #236](https://github.com/KeeprDigital/card-keepr/issues/236)
records the shared-account decision that bounds every Cloudflare token below.

Every Cloudflare token here is issued on the one account that hosts production,
dev and staging. Cloudflare's D1 and R2 permission groups apply account-wide, so
a token's name and its environment word never enforce a boundary; the application's
exact-name and exact-ID checks do. Grant each token only what its cited code path
calls, and keep each environment's values independently issued.

## Naming convention

Cloudflare API tokens are named `card-keepr <env> <purpose>` with `<env>` one of
`production`, `staging`, `dev` and `<purpose>` one of `deploy`, `d1-export`,
`d1-verification`. A token that serves an owner-only bootstrap and is revoked
afterwards uses `card-keepr <env> provision`. Nothing else should exist under
the `card-keepr` prefix. Worker secrets, GitHub secrets and shell variables keep
the exact names the code reads; those names are fixed by the inventory checks
below and change only through a guarded release.

| Target name                             | Feeds                                                         |
| --------------------------------------- | ------------------------------------------------------------- |
| `card-keepr production deploy`          | GitHub `production` secret `CLOUDFLARE_DEPLOYMENT_TOKEN`      |
| `card-keepr production d1-export`       | `card-keepr-ingestion` secret `D1_EXPORT_TOKEN`               |
| `card-keepr production d1-verification` | `card-keepr-ingestion` secret `D1_VERIFICATION_TOKEN`         |
| `card-keepr staging deploy`             | GitHub `staging` secret `STAGING_DEPLOYMENT_TOKEN`            |
| `card-keepr staging d1-export`          | `card-keepr-ingestion-staging` secret `D1_EXPORT_TOKEN`       |
| `card-keepr staging d1-verification`    | `card-keepr-ingestion-staging` secret `D1_VERIFICATION_TOKEN` |
| `card-keepr dev deploy`                 | GitHub `dev` secret `DEV_DEPLOYMENT_TOKEN`                    |
| `card-keepr dev d1-export`              | `card-keepr-ingestion-dev` secret `D1_EXPORT_TOKEN`           |
| `card-keepr dev d1-verification`        | `card-keepr-ingestion-dev` secret `D1_VERIFICATION_TOKEN`     |

Nine tokens, one consumer each. Any dashboard token outside this table has no
consumer in the code and is a revocation candidate once the owner confirms no
out-of-repository use (the 2026-09-21 list held `card-keepr d1 backup` and two
never-used tokens).

### Renaming or re-issuing a token

Renaming in the Cloudflare dashboard changes the label only; the value and the
consumer stay valid, so rename first and re-issue only when a value must change
(it appeared in a transcript, log or shell history, or its grants change). To
re-issue: create the replacement under the target name with the grants in the
tables below, install it at the consumer (`wrangler secret put` or
`gh secret set --env`), run the [probe](#probe) for that environment, then
revoke the old token. Never edit a token's value in place; a token's grants may
be edited in place when only the permission set changes (the value is unchanged
and no consumer needs an update). Ordinary tests never need any of these values.

## Cloudflare API tokens

Permission-group names follow Cloudflare's
[permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
(`D1 Edit`, `Workers Scripts Edit`, `Workers R2 Storage Read/Write`,
`Workers Routes Write`, `Zone Read`) and the Workers
[authorization model](https://developers.cloudflare.com/workers/authorization/workers/)
(`Editor`/`Metadata Read-Only` roles scoped to named Workers). Where the exact
group for an endpoint is not stated in Cloudflare's documentation it is marked
_unverified_ below; confirm it with the probe rather than by widening the grant.

### Deployment token (`<ENV>_DEPLOYMENT_TOKEN` / `CLOUDFLARE_DEPLOYMENT_TOKEN`)

Reaches the runner as `CLOUDFLARE_API_TOKEN`
([production-release.yml:106](../../.github/workflows/production-release.yml),
[production-preflight.yml:20](../../.github/workflows/production-preflight.yml),
[staging-deploy.yml:58](../../.github/workflows/staging-deploy.yml),
[dev-deploy.yml:32](../../.github/workflows/dev-deploy.yml)). The same token, in the
owner's shell, drives first provisioning and first installation for dev and
staging (`provision-dev.mjs:30`, `dev-first-install.mjs:28`, `dev-worker-shell.mjs:102`).

| Call the code makes                                                    | Code                                                                                         | Grant                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /d1/database/{id}` identity check                                 | `scripts/production-release-provider.mjs:252`, `scripts/dev-first-install.mjs:92`            | D1 Read (included in D1 Edit)                                     |
| `POST /d1/database/{id}/query` release state SQL                       | `scripts/production-release-d1.mjs:32`, `scripts/dev-first-install.mjs:23`                   | D1 Edit (statements write the release ledger)                     |
| `wrangler d1 migrations apply --remote`                                | `production-release.yml:206`, `scripts/deploy-dev.mjs:68`, `scripts/provision-dev.mjs:110`   | D1 Edit                                                           |
| `GET /d1/database?per_page=…`, `POST /d1/database` (provisioning only) | `scripts/provision-dev.mjs:42,83`                                                            | D1 Edit                                                           |
| `GET /workers/scripts/{w}/settings` secret and binding inventory       | `scripts/production-release-provider.mjs:317,336`                                            | Workers Scripts Read on both Workers                              |
| `GET …/deployments`, `GET …/versions`, `GET …/versions/{id}`           | `scripts/production-release-provider.mjs:74,131,154`, `scripts/dev-worker-shell.mjs:121,131` | Workers Scripts Read on both Workers                              |
| `wrangler versions upload --strict`, `wrangler versions deploy`        | `production-release.yml:248,263`, `scripts/deploy-dev.mjs:87,111`                            | Workers Scripts Edit (`Editor`) on both Workers                   |
| `wrangler deploy --secrets-file` deny-only shell (provisioning only)   | `scripts/dev-worker-shell.mjs:74`                                                            | Workers Scripts Edit; creating a new script needs `Admin`         |
| `wrangler triggers deploy` zone routes                                 | `production-release.yml:271`, `scripts/deploy-dev.mjs:122`                                   | Workers Routes Write on zone `keepr.digital`                      |
| `GET /zones?name=…`, `GET /zones/{z}/workers/routes`                   | `scripts/production-release-provider.mjs:184`, `scripts/dev-worker-shell.mjs:115-116`        | Zone Read on `keepr.digital`; routes read is part of Routes Write |
| `GET /r2/buckets/{b}`, `…/domains/managed`, `…/domains/custom`         | `scripts/production-release-provider.mjs:267-271`                                            | Workers R2 Storage Read                                           |
| `GET /r2/buckets`, `POST /r2/buckets` (provisioning only)              | `scripts/provision-dev.mjs:49,88`                                                            | Workers R2 Storage Write                                          |
| `GET /workers/scripts` (provisioning only)                             | `scripts/provision-dev.mjs:48`                                                               | Workers Scripts Read                                              |
| `GET /workflows/{name}` (dev, staging)                                 | `scripts/dev-workflows.mjs:19`                                                               | Workflows read; exact group name _unverified_                     |
| `GET /workers/scripts/{w}/subdomain` (first-install retry)             | `scripts/dev-worker-shell.mjs:158`                                                           | Workers Scripts Read                                              |

Minimum for the GitHub secret: D1 Edit, Workers Scripts Edit scoped to the
environment's two Workers, Workers R2 Storage Read, Zone Read and Workers
Routes Write on `keepr.digital`, plus Workflows read for dev/staging. Provisioning
additionally needs Workers R2 Storage Write and the Workers `Admin` role (new
scripts); issue that as a separate `card-keepr <env> provision` token, or grant
the deploy token these two temporarily and remove them after first installation.
The staging token issued on 2026-09-21 (`Workers Admin, D1 Edit, R2 Edit, Zone
Read + Workers Routes Edit`) is that provisioning superset and is wider than the
steady-state deploy grant; an account-owned token could not list D1/R2 and was
replaced by a user-owned one (recorded on #237). The `production` GitHub
environment holds one token for both the release and the read-only
`production-preflight` rehearsal.

### `D1_EXPORT_TOKEN` (ingestion Worker secret)

Only the catalogue SQL export (`apps/ingestion/src/backup-workflow.ts:45` →
`src/catalogue/backup-recovery/backup-recovery.ts:628` →
`POST /d1/database/{catalogue}/export` at `backup-recovery.ts:1046`). Grant: D1
Edit. Cloudflare does not document that export needs the write group, but a D1
Read token retrieves metadata and is rejected by the export endpoint (observed,
[isolated dev](isolated-dev.md#credentials-and-resources)). The export runs
under the catalogue write fence, so this token is never used against the
Disposable Restore database.

### `D1_VERIFICATION_TOKEN` (ingestion Worker secret)

| Call the code makes                                                                | Code                                                                                                             | Grant                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /d1/database?name=<disposable>` resolve the live Disposable Restore identity  | `backup-recovery.ts:1163`; callers `ingestion/routes.ts:96`, `staging-deployment.ts:115`, `dev-deployment.ts:44` | D1 Read (in D1 Edit)                                                   |
| `DELETE /d1/database/{id}`, `POST /d1/database` recreate Disposable Restore        | `backup-recovery.ts:1085,1087` via `:693`                                                                        | D1 Edit                                                                |
| `POST /d1/database/{disposable}/import`, `…/query` restore and verify              | `backup-recovery.ts:1097,1126` via `:714,733`                                                                    | D1 Edit                                                                |
| `GET /d1/database/{catalogue}/time_travel/bookmark`                                | `recovery.ts:1248` via `:254`                                                                                    | D1 Read (in D1 Edit)                                                   |
| `POST /d1/database/{catalogue}/time_travel/restore` **on the catalogue database**  | `recovery.ts:1259` via `:317`                                                                                    | D1 Edit; this token can rewrite the live catalogue                     |
| `POST /d1/database` replacement database, then import and query on it              | `recovery.ts:1273,1284,1288` via `:333-345,488`                                                                  | D1 Edit                                                                |
| **Production only:** `GET /workers/scripts/{w}/deployments`, `GET …/versions/{id}` | `ingestion/routes.ts:102` → `staging-release.ts:114` → `src/http/staging-transition.mjs:9,19`                    | Workers Scripts Read (`Metadata Read-Only`) on both production Workers |

Grant: D1 Edit for every environment; production additionally Workers Scripts
Read scoped to `card-keepr-api` and `card-keepr-ingestion`. Without that read,
`observeStagingTransition` swallows the 403 to `null`
(`staging-transition.mjs:106`) and every staging release records
`validation_scope: full` with `unknown_transition` (observed 2026-09-21 on #237).
Dev and staging never call the Workers endpoints with this token; do not grant
them there. Because it can time-travel the live catalogue, this token is the most
powerful Worker secret and is the one to rotate first after any exposure.

## Worker secrets

`scripts/production-release-provider.mjs:13-20` fixes the exact secret inventory
per Worker; `verify-target` fails a release when a deployed Worker holds more or
fewer names, and `scripts/dev-worker-shell.mjs:12-14` applies the same inventory
to provisioned dev/staging shells. Each environment's Workers carry the same
names with independently issued values.

| Worker (`card-keepr-api[-env]`) | Kind                               | Read at                    | Consumers of the same value                                                       |
| ------------------------------- | ---------------------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `API_BEARER_KEY`                | random bearer, token68, ≥ 128 bits | `apps/api/src/index.ts:64` | GitHub `API_TRAFFIC_TOKEN` (smoke), owner `KEEPR_<ENV>_API_KEY`, external readers |
| `API_BEARER_KEY_REPLACEMENT`    | random bearer, same shape          | `apps/api/src/index.ts:64` | Next key during rotation; must always exist                                       |

| Worker (`card-keepr-ingestion[-env]`) | Kind                               | Read at                                                                                                                                        | Consumers of the same value                               |
| ------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `ADMINISTRATION_KEY`                  | random bearer, token68, ≥ 128 bits | `apps/ingestion/src/index.ts:60`                                                                                                               | Owner `KEEPR_<ENV>_ADMINISTRATION_KEY` only; never GitHub |
| `ADMINISTRATION_KEY_REPLACEMENT`      | random bearer, same shape          | `apps/ingestion/src/index.ts:60`                                                                                                               | Next key during rotation; must always exist               |
| `D1_EXPORT_TOKEN`                     | Cloudflare API token (table above) | `apps/ingestion/src/backup-workflow.ts:45`                                                                                                     | None                                                      |
| `D1_VERIFICATION_TOKEN`               | Cloudflare API token (table above) | `backup-workflow.ts:46`, `backup-recovery/routes.ts:88,104`, `ingestion/routes.ts:97,102`, `staging-deployment.ts:116`, `dev-deployment.ts:45` | None                                                      |

Both bearer slots are accepted equally (`authenticateBearer` takes the pair), so a
client may hold either value. The ingestion Worker also reads the non-secret vars
`CLOUDFLARE_ACCOUNT_ID`, `CATALOGUE_D1_DATABASE_ID` and `DISPOSABLE_D1_DATABASE_ID`
from its Wrangler configuration; those are identities, not credentials.

Values live only in the Worker's secret store. For production they are installed
with `wrangler secret put <NAME> --config apps/<app>/wrangler.jsonc` (value on
stdin); for dev and staging the provisioning step installs them from the
owner-held JSON files `<ENV>_API_SECRETS_FILE` / `<ENV>_INGESTION_SECRETS_FILE`
(`dev-worker-shell.mjs:26-40` validates the exact inventory, ≥ 16 characters,
six distinct values) and later rotation uses `wrangler secret put` against the
generated `wrangler.<env>.json`. Never `wrangler secret delete` an expected slot.

### Rotating a bearer key

1. `wrangler secret put <NAME>_REPLACEMENT` with the new value; both slots are live.
2. Move every consumer to the new value: the owner profile variable, external
   readers, and for the API key the GitHub `API_TRAFFIC_TOKEN` / `<ENV>_API_TRAFFIC_TOKEN`.
3. `wrangler secret put <NAME>` with the new value, then `wrangler secret put
<NAME>_REPLACEMENT` with a fresh, unused value so the replacement slot never
   holds a retired key.
4. `pnpm --silent run keepr health --target <env> --json` proves the new value.

### Rotating a D1 token

Issue the replacement token under its target name with the grant above, `wrangler
secret put` it on the environment's ingestion Worker, run the probe, then revoke the
old token. A backup or recovery in flight holds no token copy beyond the Workflow
step that is running; wait for `keepr status` to show ingestion idle before rotating.

## GitHub environment secrets and variables

Three environments, one per target; the names come from the workflows and nothing
is defined at repository level.

| Environment  | Secret / variable                | Kind                                | Set by                           | Used at                                                                    |
| ------------ | -------------------------------- | ----------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `production` | `CLOUDFLARE_DEPLOYMENT_TOKEN`    | secret, Cloudflare deploy token     | `gh secret set --env production` | `production-release.yml:106`, `production-preflight.yml:20`                |
| `production` | `API_TRAFFIC_TOKEN`              | secret, = a production API bearer   | `gh secret set --env production` | `production-release.yml:133` → `scripts/production-smoke.mjs:22,41`        |
| `production` | `API_BASE_URL`                   | secret (non-sensitive), public base | `gh secret set --env production` | `production-release.yml:132`; must be `https://card.keepr.digital/api`     |
| `staging`    | `STAGING_DEPLOYMENT_TOKEN`       | secret, Cloudflare deploy token     | `gh secret set --env staging`    | `staging-deploy.yml:58`                                                    |
| `staging`    | `STAGING_API_TRAFFIC_TOKEN`      | secret, = a staging API bearer      | `gh secret set --env staging`    | `staging-deploy.yml:59`                                                    |
| `staging`    | `STAGING_CLOUDFLARE_ACCOUNT_ID`  | variable                            | `gh variable set --env staging`  | `staging-deploy.yml:54-55`                                                 |
| `staging`    | `STAGING_CATALOGUE_DATABASE_ID`  | variable                            | `gh variable set --env staging`  | `staging-deploy.yml:56`                                                    |
| `staging`    | `STAGING_DISPOSABLE_DATABASE_ID` | variable, initial UUID only         | `gh variable set --env staging`  | `staging-deploy.yml:57`; live value re-resolved by `D1_VERIFICATION_TOKEN` |
| `dev`        | `DEV_DEPLOYMENT_TOKEN`           | secret, Cloudflare deploy token     | `gh secret set --env dev`        | `dev-deploy.yml:32`                                                        |
| `dev`        | `DEV_API_TRAFFIC_TOKEN`          | secret, = a dev API bearer          | `gh secret set --env dev`        | `dev-deploy.yml:34` → `scripts/deploy-dev.mjs:141`                         |
| `dev`        | `DEV_CLOUDFLARE_ACCOUNT_ID`      | variable                            | `gh variable set --env dev`      | `dev-deploy.yml:28-29`                                                     |
| `dev`        | `DEV_CATALOGUE_DATABASE_ID`      | variable                            | `gh variable set --env dev`      | `dev-deploy.yml:30`                                                        |
| `dev`        | `DEV_DISPOSABLE_DATABASE_ID`     | variable, initial UUID only         | `gh variable set --env dev`      | `dev-deploy.yml:31`; live value re-resolved by `D1_VERIFICATION_TOKEN`     |

The account ID for production is read from `apps/ingestion/wrangler.jsonc`, not a
GitHub variable. No administration key, export token or verification token is
ever stored in GitHub. The automatic `github.token` (`contents: read`,
`checks: read`, `actions: read`, `id-token: write` where declared) performs the
CI checks and OIDC attestation; it needs no configuration. `API_TRAFFIC_TOKEN`
is a copy of a bearer slot, so it is rotated in step 2 of the bearer procedure
with `gh secret set <NAME> --env <env>` (value on stdin).

## Owner shell profile

`cli/environment.mjs:12-13` maps `--target <env>` to `KEEPR_<ENV>_API_KEY` and
`KEEPR_<ENV>_ADMINISTRATION_KEY` and `cli/lib/json-client.mjs:19-20` names the
missing one in its error. The unprefixed `KEEPR_API_KEY` / `KEEPR_ADMINISTRATION_KEY`
serve only the local Wrangler runtime without `--target`.

| Variable                                                                 | Kind                                           | Used at                                                                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEEPR_PRODUCTION_API_KEY`, `KEEPR_STAGING_API_KEY`, `KEEPR_DEV_API_KEY` | copy of that environment's API bearer slot     | `cli/lib/json-client.mjs:20` for `runtime: "api"`                                                                                                  |
| `KEEPR_PRODUCTION_ADMINISTRATION_KEY`, `KEEPR_STAGING_…`, `KEEPR_DEV_…`  | copy of that environment's administration slot | `cli/lib/json-client.mjs:20`; `cli/documentation.mjs:19`                                                                                           |
| `KEEPR_GITHUB_RELEASE_TOKEN`                                             | GitHub fine-grained token, ≥ 20 characters     | `cli/production-release.mjs:112`, `cli/staging-release.mjs:77` → `cli/provider-github-release.mjs:43` (`POST …/actions/workflows/{id}/dispatches`) |
| `KEEPR_GITHUB_RELEASE_ACTOR`                                             | not secret; the `expected_actor` recorded      | `cli/production-release.mjs:61`, `cli/staging-release.mjs:56`                                                                                      |
| `KEEPR_GITHUB_API_URL`, `KEEPR_GITHUB_RELEASE_WORKFLOW_ID`               | not secret; test overrides only                | `cli/production-release.mjs:117-118`, `cli/staging-release.mjs:84`                                                                                 |

`KEEPR_GITHUB_RELEASE_TOKEN` needs only **Actions: write** on `KeeprDigital/card-keepr`
(workflow dispatch); it reads nothing. Issue it as a fine-grained personal access
token scoped to this repository and rotate it in GitHub's token settings, then
update the profile. `KEEPR_GITHUB_RELEASE_ACTOR` is `github-actions[bot]` for
`release production` and the dispatching owner's login for `release staging`
(recorded on #237).

First provisioning and first installation of dev/staging run in the owner's shell
with `CLOUDFLARE_API_TOKEN` (the environment's deploy or provision token),
`GH_TOKEN` (a GitHub token with **Actions: read** and **Checks: read**, used only for
`GET …/actions/runs/{id}` and `GET …/commits/{sha}/check-runs` at
`src/http/dev-workflow-identity.mjs:112,151,167` via `scripts/provision-dev.mjs:74`),
`API_TRAFFIC_TOKEN` (= the environment's API bearer for smoke) and the two
secret-file paths. Unset them when the installation is recorded.

## Probe

`scripts/credential-probe.mjs` exercises each Cloudflare token against the exact
read-only calls above and prints one row per request with the HTTP status; token
values enter only through environment variables and never appear in the output.
Run it after issuing, renaming or rotating a token, and before any staging or
production release that follows a credential change:

```sh
KEEPR_PROBE_DEPLOYMENT_TOKEN=… \
KEEPR_PROBE_D1_EXPORT_TOKEN=… \
KEEPR_PROBE_D1_VERIFICATION_TOKEN=… \
node scripts/credential-probe.mjs production
```

For `staging` and `dev` also set `<ENV>_CLOUDFLARE_ACCOUNT_ID`,
`<ENV>_CATALOGUE_DATABASE_ID` and `<ENV>_DISPOSABLE_DATABASE_ID` (the GitHub
variable values). Omit a token variable to skip that token's rows. The probe
sends GET requests only; `--exercise-export` additionally starts one SQL export of
the live Disposable Restore database with each D1 token, which is the only
read-only way to tell D1 Edit from D1 Read. Write capabilities (version upload,
route deploy, migrations, import, time-travel restore) are listed as `not_probed`.

A failed `D1_VERIFICATION_TOKEN` `workers-deployments-read` row is the cause of
`unknown_transition` on every staging release; a failed `d1-list-by-name` row
is the cause of the staging `POST /v1/staging-deployments` 500 seen on
2026-09-21 when the ingestion secrets were random strings instead of tokens.
Exit 0 means every probed row passed; the probe cannot prove grants it does not
exercise, so a green probe followed by a failed release still needs the
[production-preflight](production-release.md) rehearsal or the release log.
