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

| Location                         | Required values                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub `staging` variables       | `STAGING_CLOUDFLARE_ACCOUNT_ID`, `STAGING_CATALOGUE_DATABASE_ID`, initial `STAGING_DISPOSABLE_DATABASE_ID`                                                      |
| GitHub `staging` secrets         | `STAGING_DEPLOYMENT_TOKEN`, `STAGING_API_TRAFFIC_TOKEN`                                                                                                         |
| Owner-held API secret file       | `API_BEARER_KEY`, `API_BEARER_KEY_REPLACEMENT`                                                                                                                  |
| Owner-held ingestion secret file | `ADMINISTRATION_KEY`, `ADMINISTRATION_KEY_REPLACEMENT`, `D1_EXPORT_TOKEN`, `D1_VERIFICATION_TOKEN`                                                              |
| Owner CLI                        | Separate `KEEPR_PRODUCTION_ADMINISTRATION_KEY`, `KEEPR_STAGING_ADMINISTRATION_KEY`, scoped API keys, `KEEPR_GITHUB_RELEASE_TOKEN`, `KEEPR_GITHUB_RELEASE_ACTOR` |

Issue credentials independently; no administration key belongs in Actions.
The separate export and restore-verification credentials need D1 Write, as
described in the dev procedure. Automatic scope classification also needs
read access to the active production Worker versions; if that access is absent,
the server explicitly selects full validation. Do not silently enlarge a token's
authority to avoid this fallback.

## One owner intent

Invoke `release staging --target production` because production owns the release
intent and actual starting state. This command dispatches only staging. Supply
`--release-id`, `--expected-head-sha` (full SHA), `--ci-run-id`,
`--validation-scope auto`, `--idempotency-key`, `--yes` and `--json`.
The first invocation returns `confirmation_required` and the complete resolved
confirmation document. Repeat with `--confirm` equal to that exact document.
This is one owner confirmation. `full` can request stronger validation; a weaker
scope than the server requires is refused.

Production records the immutable SHA, owner GitHub actor, CI run, actual target
and schema level, validation scope/reason, required checks and a 24-hour deadline.
The CLI submits only server-issued release ID, intent digest and exact SHA to
`staging-deploy.yml` on main. The workflow checks out that SHA even if main has
advanced. Repeating an identical owner request returns the original intent;
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

Every scope requires exact-commit CI, an isolated real-SQL migration rehearsal
from production's recorded starting schema level, and live staging smoke.
The rehearsal derives its ending level and migration digests from the selected
checkout. It constructs a synthetic predecessor baseline, applies each forward
migration transactionally, checks previous-level rejection, foreign keys and
integrity. It does not import production data or prove every populated migration
case; the selected commit's routine migration tests provide that separate proof.

Scope classification requires the retained successful production release to
match the actual fully active Worker pair and target bindings, plus a complete
bounded GitHub comparison to the selected commit, including rename sources.
Missing provider access, absent provenance, split activation or truncated
comparison selects `full` with `unknown_transition`.

| Verified changes                                  | Additional retained-data scenarios            |
| ------------------------------------------------- | --------------------------------------------- |
| Documentation, CLI or tests only                  | None (`routine`)                              |
| Backup/recovery                                   | `composed-recovery`                           |
| Sources/adapters                                  | `one-piece-two-source`, `riftbound-catalogue` |
| Both families, shared model, or unclassified code | All three (`full`)                            |

Extended scenarios run offline from retained fixtures without deployment,
administration, GitHub or OIDC credentials in their child process. The workflow
has a finite 90-minute budget and never cancels an active staging deployment.
There is no push/merge trigger.

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

#238 must bind continuation to the same intent/SHA and successful required
staging evidence, then acquire fresh production CI, state, recovery, target and
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
[GitHub compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits).
