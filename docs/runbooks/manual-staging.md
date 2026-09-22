# Manual staging release

[Issue #237](https://github.com/KeeprDigital/card-keepr/issues/237) owns staging
implementation and operational acceptance. This procedure describes the available
code; successful local tests do not establish a live staging installation or
release. [Issue #238](https://github.com/KeeprDigital/card-keepr/issues/238) owns
production continuation. Staging success alone never deploys production or copies
staging catalogue data or owner interpretations into it.

## First installation

Use the owner-selected account `3ec389380c7b82e6a172e6f351d4aad9` and hostname
`card-staging.keepr.digital`, covered by the existing `*.keepr.digital`
certificate. The accepted shared account-wide provider authority remains as
recorded in [architecture](../architecture.md#software-release-direction).
Credentials, data, names, routes and cleanup inventory must remain distinct from
dev and production.

The guarded [first-install procedure](isolated-dev.md#capacity-and-first-installation)
also serves staging. Set `RELEASE_ENVIRONMENT=staging` for **both**
`scripts/provision-dev.mjs` and `scripts/dev-first-install.mjs`; use `STAGING_`
instead of `DEV_` for every account, database, secret-file, receipt and inspected
retry variable. Keep the common exact `EXPECTED_HEAD_SHA`, `CI_RUN_ID`,
`GH_TOKEN`, `CLOUDFLARE_API_TOKEN` and `API_TRAFFIC_TOKEN`. Select a commit
contained in main with complete successful push-main or manual-main CI.

Provisioning `plan` refreshes the inventory without writes. Staging reserves
three replacement D1 slots across production, dev and staging, in addition to
its two new databases. An unknown plan uses conservative Free limits and reserves
five full 500 MB new/replacement targets. A confirmed Paid plan uses published
database/script counts; this is a count check, not a throughput or total Paid
storage guarantee. Inspect account storage and runtime suitability before apply.
The owner confirmed Workers Paid in #236; refresh evidence before provisioning.
Neither that observation nor plan output reserves provider resources.

Apply creates only new staging D1/R2 and private deny-only Worker shells with
independently issued secrets. It refuses existing names and retains a receipt
through partial failure. First installation checks exact database identities,
an unused baseline and successful exact-commit CI, then uses canonical release
preparation and the shared lease/executor. The inspected retry path accepts only
completed failed bootstrap history and still-unbound deny-only Workers; it never
resets a used catalogue or adopts an application Worker. Configure staging's
proxied DNS placeholder before smoke. Generated `apps/*/wrangler.staging.json`
files are ignored and compiled from provider-issued UUIDs; do not invent IDs.

The compiler owns exact resources: Workers `card-keepr-api-staging` and
`card-keepr-ingestion-staging`; D1 `card-keepr-catalogue-staging` and
`card-keepr-disposable-verification-staging`; the four existing R2 and Workflow
names suffixed `-staging`; the service binding to the staging ingestion Worker;
and rate-limit namespaces 3001–3005. Routes mount `/api` and `/ingest` on the
selected hostname. Public R2 access, Workers.dev and preview URLs remain disabled.
Catalogue operations and restore/cleanup use staging's own environment inventory.
The Disposable Restore UUID can rotate; each release discovers its current exact
name through staging's independent verification credential.

Production must separately run a reviewed release containing the production
intent/authorization endpoints before owner initiation can work. Install the
staging runtime and configure its GitHub environment before dispatching the
first real manual release. Initial installation is not evidence of that release.

The [credentials inventory](credentials.md) lists every staging value: the
GitHub `staging` variables and secrets, the owner-held API and ingestion secret
files, and the owner CLI profile (`KEEPR_STAGING_*`, `KEEPR_GITHUB_RELEASE_TOKEN`,
`KEEPR_GITHUB_RELEASE_ACTOR`), with each token's minimum grant and the read-only
probe to run after issuing or rotating one.

Issue credentials independently; no administration key belongs in Actions.
Staging needs no production Workers read: production records the intent from its
own D1 state and never inspects its active Worker versions.

## Same-zone authorization fetch

The staging ingestion Worker verifies each owner intent by fetching
production's `/v1/staging-release-authorizations` route over public HTTPS.
Both Workers share the `keepr.digital` zone, and Cloudflare routes a Worker's
same-zone `fetch()` to the zone origin (the `100::` placeholder) unless the
`global_fetch_strictly_public` compatibility flag is set. The ingestion
configuration declares that flag; without it staging reports
`staging_authorization_refused` while production records nothing
(`acceptance/staging-worker-config.test.mjs`).

## One owner intent

Invoke `release staging --target production` because production owns the release
intent and actual starting state. This command dispatches only staging. Supply
`--release-id`, `--expected-head-sha` (full SHA), `--ci-run-id`,
`--idempotency-key`, `--yes` and `--json`.
The first invocation returns `confirmation_required` and the complete resolved
confirmation document. Repeat with `--confirm` equal to that exact document.
This is one owner confirmation.

Production records the immutable SHA, owner GitHub actor, CI run, actual target
and schema level, the fixed required checks and a 24-hour deadline.
The CLI submits only server-issued release ID, intent digest and exact SHA to
`staging-deploy.yml` on main. The workflow first checks out its trusted workflow
SHA and claims the production intent before executing any dispatch-selected
code. Only after that authorization does it check out the selected SHA, even if
main has advanced. Deployment and API credentials are scoped to the final
execution step; neither dependency setup nor the authorization gate receives them. Repeating an identical owner request returns the original intent;
changing its choices conflicts. Lost responses do not extend deadlines.

Only a signed GitHub manual workflow identity with the staging environment,
fixed repository/owner IDs, main workflow ref, owner actor and an in-progress
run/attempt may claim the production intent. The audience is production's
`/ingest/v1/staging-release-authorizations` endpoint. Production verifies complete
successful CI for the selected SHA contained in main. The selected SHA need not
equal the workflow file's newer main SHA. Another workflow/run attempt cannot
take over the claim. A new attempt after expiry or failure needs a fresh owner
intent. Replaying the original claim still verifies signature, actor and running
attempt; it returns the same claim even if CI later fails, so the workflow can
retain that failure. Actual deployment independently rechecks CI.

Staging forwards the same signed token to the fixed production HTTPS endpoint;
it never trusts a caller-supplied production snapshot. It resolves its own live
target and guarded release state. Initial preparation and mutation claim must
fit the original five-minute claim window; replay cannot renew it. Deployment
uses the existing 45-minute canonical lease, migration guards, strict version
uploads, exact pair activation, binding verification and authenticated smoke.

## Validation and retained outcomes

Every staging release runs the same three checks: exact-commit CI, an isolated
real-SQL migration rehearsal from production's recorded starting schema level,
and live staging smoke. The rehearsal derives its ending level and migration
digests from the selected checkout. It constructs a synthetic predecessor
baseline, applies each forward migration transactionally, checks previous-level
rejection, foreign keys and integrity. It does not import production data or
prove every populated migration case; the selected commit's routine migration
tests provide that separate proof. The staging job has a 30-minute limit; the
guarded path measured about three minutes on #237.

Staging does not replay retained-source scenarios. `composed-recovery`,
`one-piece-two-source` and `riftbound-catalogue` run once per release candidate
in `extended-scenarios.yml`, which records the `extended-scenarios` commit status
on that exact SHA ([#238](https://github.com/KeeprDigital/card-keepr/issues/238)).
It runs on a `v*` tag push, when another workflow calls it, and on manual dispatch:

```sh
gh workflow run extended-scenarios.yml --ref main -f sha=<full-sha-contained-in-main>
```

It refuses a SHA outside `main` and skips a SHA that already has a successful
record written by `github-actions[bot]`. Its scenario jobs run offline from
retained fixtures with no deployment, administration, OIDC or status-write
credentials. Only the trusted jobs that check out no selected code write the
status. A staging outcome does not include this record; production promotion
must require both. Intents recorded before this change listed
`retained-source-rehearsal` among their required checks. No current runner or
outcome can satisfy them, so they remain inspectable but cannot complete.
There is no push/merge trigger for staging.

Production records the intent, so production must run the fixed-check code
before staging can use it. A production runtime from before this change still
requires `validation_scope`; it rejects the current CLI's request and demands the
retired replay. Ship the change through a guarded Production Release first, then
create staging intents.

The immutable staging outcome separates deployment, migration rehearsal and
every required validation check. Missing, pending, mismatched or failed checks
cannot become success. A successful deployment requires its exact canonical
completion receipt; a successful deployment followed by failed validation is a
failed staging release. Failures stop continuation and remain inspectable.
The workflow retains attempt artifacts for 90 days, including evidence whose
SHA-256 hashes cover the exact stored file bytes. A runner killed before callback
can leave no terminal outcome; absence is never success. Inspect retained
artifacts and the release fence before creating another owner intent.

Use `release staging-status --release-id <id> --target production --json` to
inspect intent and claim; select `--target staging` to inspect its preparation
and outcome. Status returns exit 0 for a retrieved document, including `failed`;
read its outcome state. Dispatch returns exit 10, which only acknowledges the
request. No status code substitutes for a successful immutable outcome.

#238 must bind continuation to the same intent/SHA, successful required staging
evidence and a successful `extended-scenarios` record on that SHA, then acquire fresh production CI, state, recovery, target and
lease guards. It must not reuse staging's expired preparation or ask for a routine
second owner approval. The broader retained intent and the short deployment
lease are separate authorities.

Keep #237 open until actual provisioning, first installation, owner initiation,
successful exact-SHA staging validation and unchanged-production evidence are
recorded on the issue. Local signed fixtures and simulated provider calls prove
protocol behavior, not a real release or Go-Live.

References: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/),
[GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc),
[workflow SHA and step contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts),
[GitHub compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits).
