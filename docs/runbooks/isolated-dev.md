# Isolated dev

[Issue #236](https://github.com/KeeprDigital/card-keepr/issues/236) implements the
dev slice of the accepted [software release direction](../architecture.md#software-release-direction).
The automatic dev path is available after the guarded first installation below.
Staging selection and production promotion remain separate work under
[issue #216](https://github.com/KeeprDigital/card-keepr/issues/216).

## Authority and exact commits

`dev-deploy.yml` reacts only to completed successful `ci` runs for pushes to main
in this repository. Checkout pins the triggering run's full SHA. It never resolves
`main` again as the deployment revision, never triggers staging, and never cancels
an active dev deployment. CI itself remains non-mutating.

The checked-out commit's shared `.github/actions/setup-toolchain` action selects
the repository-pinned Node, Corepack and pnpm versions and installs the frozen
lockfile. The required complete CI check set applies even while this PR is a draft;
reduced draft CI cannot authorize deployment.

GitHub documents `workflow_run`'s `GITHUB_SHA` as the last commit on the default
branch, while `github.event.workflow_run.head_sha` identifies the triggering CI
commit. These can differ. The job intentionally skips a stale completion when
they differ; preparation independently requires the requested commit to equal
both signed OIDC `sha` and `workflow_sha`. It never substitutes newer main or
uses earlier CI to validate a newer commit. The next successful CI completion for
the current main commit starts its own deployment. To retry while main is
unchanged, rerun CI for that exact commit. An older commit cannot be deployed by
rerunning CI after main has advanced. See GitHub's
[event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
and [OIDC claims](https://docs.github.com/en/actions/reference/security/oidc).

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

Backup verification replaces the Disposable Restore database, so its initial
UUID is not a permanent identity. After authenticating the workflow, preparation
uses the ingestion Worker's D1 verification credential to resolve the single
live database with the exact dev scratch name. Missing, ambiguous or unavailable
inventory refuses preparation. The workflow passes that observed UUID to the
config compiler before deployment; provider UUID/name checks still apply.

`scripts/deploy-dev.mjs` is the shared guarded executor. Before mutation it checks
checkout SHA, CI and exact dev configs/resources/secrets. It claims the retained
plan, migrates, verifies uploaded version bindings, activates the compatible pair,
applies routes, observes bindings and runs authenticated API smoke plus ingestion
auth/liveness checks. Failure invokes the existing fence/failure handler. It never
resets data, accepts a recovery, or approves a Catalogue Candidate.

## Credentials and resources

| Location                                 | Required configuration                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| GitHub `dev` environment variables       | `DEV_CLOUDFLARE_ACCOUNT_ID`, `DEV_CATALOGUE_DATABASE_ID`, `DEV_DISPOSABLE_DATABASE_ID`             |
| GitHub `dev` environment secrets         | `DEV_DEPLOYMENT_TOKEN`, `DEV_API_TRAFFIC_TOKEN`                                                    |
| API Worker secret file, owner-held       | `API_BEARER_KEY`, `API_BEARER_KEY_REPLACEMENT`                                                     |
| Ingestion Worker secret file, owner-held | `ADMINISTRATION_KEY`, `ADMINISTRATION_KEY_REPLACEMENT`, `D1_EXPORT_TOKEN`, `D1_VERIFICATION_TOKEN` |
| Owner CLI dev profile                    | `KEEPR_DEV_API_KEY`, `KEEPR_DEV_ADMINISTRATION_KEY`                                                |

`DEV_DISPOSABLE_DATABASE_ID` starts with the provisioned UUID for first installation.
Automatic deployment replaces that value for its job from authenticated preparation;
backup rotation does not require manually updating the saved GitHub variable.

Secrets must be independently issued for dev, with minimum provider-supported
permissions. No production credential is copied. No administration credential is
stored in Actions. Cloudflare's
[permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
defines D1 Edit and Workers Scripts Edit at account scope. A separate token on the
existing shared account therefore has provider authority over production resources
too; its name does not enforce a dev-only boundary. Application namespace/binding
checks constrain this executor's requests, but cannot contain a compromised token.
Before configuring live credentials, record the owner's choice of shared-account
authority or a separate non-production account. The selected account must also
own the configured `keepr.digital` route zone: the current compiler preserves
that zone and the provider verifier rejects foreign-account zones. A separate
account therefore needs its zone/DNS arrangement resolved before installation;
changing the account ID alone does not establish a usable isolated route.

The config compiler owns the exact target inventory:

| Resource                          | Dev identity                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| API / ingestion Workers           | `card-keepr-api-dev`, `card-keepr-ingestion-dev`                                                                                        |
| Catalogue / Disposable Restore D1 | `card-keepr-catalogue-dev`, `card-keepr-disposable-verification-dev`; distinct provider-issued UUIDs                                    |
| Private R2                        | `card-keepr-evidence-dev`, `card-keepr-printing-images-dev`, `card-keepr-catalogue-exports-dev`, `card-keepr-backups-dev`               |
| Workflows                         | `card-keepr-evidence-ingestion-dev`, `card-keepr-evidence-host-dev`, `card-keepr-reconciliation-dev`, `card-keepr-catalogue-backup-dev` |
| Service binding                   | `OFFICIAL_SOURCE_TRANSPORT` → `card-keepr-ingestion-dev` / `OfficialSourceTransport`                                                    |
| Rate limits                       | API 2001, image 2002, administration 2003, API liveness 2004, ingestion liveness 2005                                                   |

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

Provisioning checks each exact dev Workflow name through the provider API and
refuses any occupied name. Deployment repeats these lookups before mutation,
version upload, activation and trigger updates, allowing only absent names or
the expected dev ingestion script and class. Provider failures stop the operation.
These observations cannot lock the provider namespace against concurrent actors;
they do not replace the credential authority decision above.

## Capacity and first installation

Retain a fresh evidence JSON with `account_id`, `observed_at`, `workers_plan`
(`unknown`, `free`, or `paid`) and `plan_evidence`. The provisioner refreshes live
D1/Worker/R2 counts and D1 sizes immediately. Unknown plan uses the conservative
Free limits: ten databases, 500 MB per database, 5 GB total, 100 Worker scripts.
Two additional D1 slots are reserved for simultaneous production/dev replacement
recovery, beyond the two steady-state dev databases. Storage reserves four full
500 MB new/replacement targets. This establishes provisioning headroom, not
measured ingestion capacity or a future staging allocation.

Keep dated inventory, plan output and validation in ignored `.artifacts/` while
working; record the relevant evidence with the issue or PR. Refresh observations
before each operation. Capacity evidence does not authorize deployment and a
conservative Free count/storage check does not establish runtime-plan suitability.
The configured Worker CPU/subrequest limits must be supported by the selected
account before installation.

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
4. Configure the proxied dev DNS placeholder before authenticated smoke checks.
   Set `DEV_CATALOGUE_DATABASE_ID` and `DEV_DISPOSABLE_DATABASE_ID` from the receipt,
   and `API_TRAFFIC_TOKEN` to the dev API key. Run
   `node scripts/dev-first-install.mjs`. It rechecks CI, exact provider names/IDs,
   and an unused dev baseline (no catalogue revisions, runs or administration
   ledger). The same server plan validator and atomic preparation transaction run
   through the documented D1 batch query API; no ledger is copied or hand-written.
   The shared guarded executor performs the application installation.
5. Configure the GitHub dev environment, then retain successful first
   installation and subsequent automatic-merge deployment evidence. After partial
   first-install failure, inspect the retained fence/preparation; the tool refuses
   to overwrite the used baseline. Do not reset it to retry.

For ordinary owner operations, `pnpm --silent run keepr status --target dev --json`
selects the dev profile. The [administration contract](../../contracts/ADMINISTRATION.md#interaction-rules)
owns scoped credentials, environment confirmations and command behavior. Dev uses
the same [native publication](publication.md) and [backup/recovery](backup-recovery.md)
protocols as production against its own data; collection alone does not publish.

## Evidence and remaining live gates

Local tests use signed synthetic GitHub attestations, injected CI/provider failures,
real SQLite migrations and the canonical preparation code. They are not evidence
of an actual GitHub runner or Cloudflare deployment, and contain no real Source
captures. Live acceptance requires the real exact-SHA CI run, resource receipt,
verified secret/route/binding inventory, first-install result and subsequent
automatic dev smoke result. Keep CI evidence bound to the actual integrated commit;
historical main, draft or local results do not establish live automatic deployment.

References: [GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 batch query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/),
[Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/).
