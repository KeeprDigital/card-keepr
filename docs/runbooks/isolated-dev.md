# Isolated dev

Issue #236 implements the dev slice of #216/ADR 0016. It reuses #151/PR199's
resource inventory and scratch-isolation findings. PR199's automatic staging and
manual production triggers are superseded: this workflow deploys only dev.
Production and staging release behavior is outside this slice.

## Authority and exact commits

`dev-deploy.yml` reacts only to completed successful `ci` runs for pushes to main
in this repository. Checkout pins the triggering run's full SHA. It never resolves
`main` again as the deployment revision, never triggers staging, and never cancels
an active dev deployment. CI itself remains non-mutating.

The dev ingestion Worker exposes `POST /v1/dev-deployments` under its `/ingest`
mount. Production and staging return 404. It accepts no administration key. A
GitHub OIDC JWT must verify against GitHub's fixed JWKS URL with RS256, the dev
endpoint audience, the dev environment subject, immutable repository/owner IDs,
main ref, and the exact `dev-deploy.yml` workflow identity. Issuance/expiry, run ID
and attempt are checked. The supplied short-lived GitHub workflow token is used
only for fresh read-only GitHub checks; it is never stored. The deployment run
must still be in progress. CI must be a successful completed push-main run for the
requested SHA, the SHA must be contained in main, and every expected check must
be present once and successful on that SHA. Missing, pending, failed, mismatched,
ambiguous or unavailable checks refuse preparation.

The endpoint resolves its own live dev target and catalogue state. It calls the
same server preparation logic used by the existing release protocol, retaining
its immutable preparation ledger, canonical lease, migration/schema checks,
recovery checks, and populated/empty catalogue distinctions. A workflow attempt
can prepare once; a replay is rejected. A new attempt does not waive live guards.
The initial mutation claim must consume the exact preparation within five minutes.
The lease then bounds the existing 45-minute operation. Expired preparation is
not renewed by recompiling SQL. The record and its actual target remain auditable;
legacy `production_release` wire/ledger names are reused only inside the isolated
dev database and do not confer production authority.

`scripts/deploy-dev.mjs` is the shared guarded executor. Before mutation it checks
checkout SHA, CI and exact dev configs/resources/secrets. It claims the retained
plan, migrates, verifies uploaded version bindings, activates the compatible pair,
applies routes, observes bindings and runs authenticated API smoke plus ingestion
auth/liveness checks. Failure invokes the existing fence/failure handler. It never
resets data, accepts a recovery, or approves a Catalogue Candidate.

## Credentials and resources

| Location | Required configuration |
| --- | --- |
| GitHub `dev` environment variables | `DEV_CLOUDFLARE_ACCOUNT_ID`, `DEV_CATALOGUE_DATABASE_ID`, `DEV_DISPOSABLE_DATABASE_ID` |
| GitHub `dev` environment secrets | `DEV_DEPLOYMENT_TOKEN`, `DEV_API_TRAFFIC_TOKEN` |
| API Worker secret file, owner-held | `API_BEARER_KEY`, `API_BEARER_KEY_REPLACEMENT` |
| Ingestion Worker secret file, owner-held | `ADMINISTRATION_KEY`, `ADMINISTRATION_KEY_REPLACEMENT`, `D1_EXPORT_TOKEN`, `D1_VERIFICATION_TOKEN` |
| Owner CLI dev profile | `KEEPR_DEV_API_KEY`, `KEEPR_DEV_ADMINISTRATION_KEY` |

Secrets must be independently issued for dev, with minimum provider-supported
permissions. No production credential is copied. No administration credential is
stored in Actions. Some Cloudflare D1 management permissions are account-scoped:
separate token values do not create a provider-enforced database security boundary.
The exact namespace/binding guards remain necessary; a separate account is needed
if isolation against a compromised account-scoped credential is required.

Dev uses `card-keepr-api-dev` and `card-keepr-ingestion-dev`, one catalogue D1 and
one `card-keepr-disposable-verification-dev`, four `-dev` R2 buckets, four `-dev`
Workflow names, its own service binding and rate-limit namespaces 2001–2005.
Routes are `dev.card.keepr.digital/api[/…]` and `/ingest[/…]`. Configure a proxied
DNS placeholder for that hostname in `keepr.digital`; do not change production
DNS. R2 public access stays disabled. Workers.dev and preview URLs stay disabled.

The config compiler requires real distinct UUIDs and rejects production D1 IDs.
Generated `apps/*/wrangler.dev.json` files are ignored and rebuilt from the exact
checkout. They explicitly select every resource; environment inheritance cannot
silently supply production bindings. Scratch deletion uses exact returned names,
never an account-wide filter result or a configured/prior ID alone. Stale IDs may
be absent after a previous successful cleanup; they do not authorize deletion of
another namespace. Replacement databases are never scratch.

## Capacity and first installation

Retain a fresh evidence JSON with `account_id`, `observed_at`, `workers_plan`
(`unknown`, `free`, or `paid`) and `plan_evidence`. The provisioner refreshes live
D1/Worker/R2 counts and D1 sizes immediately. Unknown plan uses the conservative
Free limits: ten databases, 500 MB per database, 5 GB total, 100 Worker scripts.
Two additional D1 slots are reserved for simultaneous production/dev replacement
recovery, beyond the two steady-state dev databases. Storage reserves four full
500 MB new/replacement targets. This establishes provisioning headroom, not
measured ingestion capacity or a future staging allocation.

Current read-only evidence is in `docs/evidence/236-dev-prerequisites.json`.
Refresh it before an operation; it deliberately does not authorize deployment.

The owner-only first installation is outside the administration CLI:

1. Check out the exact intended main commit and obtain its genuinely successful
   complete CI run. Set `EXPECTED_HEAD_SHA`, `CI_RUN_ID`, `GH_TOKEN`,
   `DEV_CLOUDFLARE_ACCOUNT_ID` and the dev `CLOUDFLARE_API_TOKEN`. Local tests cannot
   substitute for these CI results.
2. Supply owner-held JSON secret files through `DEV_API_SECRETS_FILE` and
   `DEV_INGESTION_SECRETS_FILE`, and an output path `DEV_PROVISION_RECEIPT` outside
   the repository. Run `node scripts/provision-dev.mjs plan capacity-evidence.json`
   to review the exact inventory, then `apply` with the same arguments.
   Apply verifies CI before creating resources. Existing dev names stop it;
   interrupted provisioning retains a receipt and never deletes or silently
   adopts resources. Review that receipt before a subsequent recovery operation.
3. Provisioning creates only dev D1/R2 and deny-only Worker shells with secrets,
   no routes, and no data/service/Workflow bindings. Shells are needed because the
   first `versions upload` requires an existing script. They cannot serve or
   mutate catalogue data. The new, still-unbound catalogue receives the baseline.
4. Set `DEV_CATALOGUE_DATABASE_ID` and `DEV_DISPOSABLE_DATABASE_ID` from the receipt,
   and `API_TRAFFIC_TOKEN` to the dev API key. Run
   `node scripts/dev-first-install.mjs`. It rechecks CI, exact provider names/IDs,
   and an unused dev baseline (no catalogue revisions, runs or administration
   ledger). The same server plan validator and atomic preparation transaction run
   through the documented D1 batch query API; no ledger is copied or hand-written.
   The shared guarded executor performs the application installation.
5. Configure the GitHub dev environment and DNS, then retain successful first
   installation and subsequent automatic-merge deployment evidence. After partial
   first-install failure, inspect the retained fence/preparation; the tool refuses
   to overwrite the used baseline. Do not reset it to retry.

For ordinary owner operations, `node cli/keepr.mjs status --target dev --json`
selects only scoped keys and canonical dev URLs. Mutations that require an
`--environment` confirmation use `--environment dev` with `--target dev`; exact
resolved-target confirmations remain required. Curated Revision operations retain
their separate stdin-secret interface. Omitting `--target` preserves existing local
and production CLI behavior. `release production --target dev` is rejected.

## Evidence and remaining live gates

Local tests use signed synthetic GitHub attestations, injected CI/provider failures,
real SQLite migrations and the canonical preparation code. They are not evidence
of an actual GitHub runner or Cloudflare deployment, and contain no real Source
captures. Live acceptance requires the real exact-SHA CI run, resource receipt,
verified secret/route/binding inventory, first-install result and subsequent
automatic dev smoke result. At implementation time Actions run 34033467488 failed
before all nine jobs started due billing/spending allowance; no local override was
added and no billing or production operation was performed.

References: [GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 batch query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/),
[Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/).
