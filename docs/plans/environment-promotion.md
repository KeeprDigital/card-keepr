# Environment promotion: deferred #151 revisit

Status: implementation design for the revisit required by #155, 2026-09-04.
Production promotion retains the provisional CLI confirmation decision in #151.
This document describes the target and remaining implementation work; it does not
claim that dev or staging has been provisioned or deployed.

## Decisions carried forward

| Decision | Implementation consequence |
| --- | --- |
| D1: subdomains | `dev.card.keepr.digital` and `staging.card.keepr.digital`, each with `/api` and `/ingest` mounts and proxied DNS placeholders |
| D2: production preparation stays in CLI | Publishing a GitHub Release makes its exact tag/SHA eligible for owner-confirmed promotion; it cannot authorize deployment by itself while required reviewers are unavailable |
| D3: staging owns ingestion | Staging collects Official Sources and publishes its own Catalogue Revisions; no shared production D1, evidence, exports, or backup bucket |
| D4: release-please | Generate release PRs, tags, and release notes from Conventional Commits; keep definition versions governed by ADR 0008 |
| D5: confirm account limits | Provision only after identifying the Workers plan and reserving capacity for replacement recovery, not just the steady-state databases |
| D6: before Go-Live | Exercise isolated deployments and staging recovery before the explicit owner Go-Live call in #136 |

D2 limits the original acceptance criterion “a published GitHub Release deploys
production … with no hand-copied confirmation.” Automated production dispatch
requires a later owner decision and an accepted replacement for the present human
gate. Removing confirmation, storing the production administration key in Actions,
or treating the release publisher as implicit recovery/target approval would not
implement the decision above.

## Verified starting point

At main `97649c4`, each app still has one top-level Wrangler configuration, two
Workers share one catalogue D1, and ingestion owns four Workflow bindings plus a
self service binding for Official Source transport. Phase 4 is merged: #94 removed
synthetic adapters from shipped code and #111 moved client-side release validation
and canonical plan construction into the administration service. A deployed dev
environment therefore uses the same production adapter bundle; test fixtures
remain local test composition, even though the original #151 proposal allowed
synthetic dev sources.

The #136 baseline draft also identified a separate Go-Live dependency: changing
bindings to a fresh database cannot transfer the old database's immutable release
preparation. Its proposed handoff requires a prerequisite protocol release and
durable mutation fencing on both databases. Environment promotion must not treat
Bootstrap Mode as a shortcut around that missing authority transfer. The baseline
fold must be refreshed after that protocol's schema is final.

Read-only account checks on 2026-09-04 found six D1 databases in the account,
including the catalogue and disposable verification database, and seven R2 buckets,
four belonging to Card Keepr. No dev/staging resources were found in those
inventories. The GitHub `production` environment currently reports no protection
rules and no deployment branch policy. The CLI confirmation and release workflow's
own exact-SHA provenance checks therefore remain essential; configuring a branch
policy is still a release prerequisite.

The latest main CI run (`33850907639`) failed all nine jobs without a runner
assignment. #155 records exhausted Actions minutes and permits local merge gates;
it does not waive the production workflow's successful-CI gate. Automated dev and
staging runs also require working Actions capacity.

## Resource inventory and quota headroom

Each environment needs two Worker scripts, one catalogue D1, one disposable
verification target, four private R2 buckets, four Workflow names, and five unique
rate-limit namespaces. All service bindings must point to the environment's own
ingestion Worker. Vars, bindings, and secrets must be specified independently in
`env.dev` and `env.staging`; Wrangler does not inherit them from the top level.
[Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)

| Resource | Dev/staging addition | Cross-environment check |
| --- | --- | --- |
| Worker scripts | Four | Names, routes, version bindings and service targets all belong to the selected environment |
| Catalogue D1 | Two | API and ingestion share only their own environment's database |
| Disposable verification D1 | Two steady-state targets | Backup restore generations may replace only their environment's target |
| Private R2 | Eight | Evidence, images, exports and backups have distinct names per environment and remain private |
| Workflows | Eight | All names have the environment suffix and bind to the matching Worker |
| Rate-limit namespaces | Ten | Separate identities prevent dev load from consuming production quotas |

The D1 Free limit is ten databases and Paid is 50,000; Free also limits a database
to 500 MB versus Paid's 10 GB. Starting with six account databases, four additional
steady-state targets would exhaust the Free database count and leave no replacement
recovery headroom. The configured plan has not been verified: Wrangler OAuth has
no Billing Read permission, which the subscription API requires. This is an
unresolved provisioning gate, not evidence that the account is on Free.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[subscription permissions](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/)

Twelve Card Keepr buckets are below the published R2 bucket limit. Workflows share
Worker script and account execution limits; assess CPU, instance concurrency and
source-collection volume against the confirmed plan rather than treating twelve
Workflow names as the capacity test.
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/),
[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)

### Isolation must include backup scratch databases

`src/catalogue/backup-recovery/backup-recovery.ts` currently finds and deletes
scratch targets by the literal name `card-keepr-disposable-verification`. Merely
adding `env.staging` would let a staging backup delete production's disposable
restore target. Before any environment deployment, derive the scratch inventory
name from the verified environment target and restrict deletions to that namespace
plus the operation's recorded prior target. The configured target ID alone is
insufficient because later Restore Generations create a new ID. Replacement
recovery database names must also include the environment identity.

Prove this using provider HTTP tests: inventory contains targets from all three
environments; only the selected environment's stale generations may be deleted;
ambiguous imports still allocate a clean generation; retained production and
replacement databases are never treated as scratch. Provider tokens must have the
minimum available resource scope, with production credentials inaccessible to dev
or staging jobs.

## Promotion protocol

1. CI validates the exact merged main SHA. A deployment must consume evidence for
   that SHA, not whichever branch head is newest when a job starts. Superseded
   queued dev work may be cancelled before mutation; an active guarded release
   must finish or retain failure evidence rather than being killed mid-migration.
2. Dev deploys that SHA through the environment-selected release compiler and
   binding verification, then passes authenticated readiness and liveness smoke.
   Dev data is disposable, but automatic deployment must not silently delete it;
   a schema regeneration precondition must produce an explicit reset operation.
3. Staging deploys the same SHA only after dev succeeds. It exercises guarded
   forward migrations from the recorded prior level, complete version/secret
   inventory verification, route triggers, and the full applicable smoke suite.
   Its catalogue comes from its own ingestion runs. Bootstrap Mode is available
   while empty, and ordinary evidence gates apply after publication.
4. Release-please creates a reviewed release PR and publishes the resulting tag
   and notes. Resolve tags to full commit SHAs and require retained staging success
   for that exact SHA. Version upload messages carry the release tag and concise
   changelog reference; catalogue schema/profile identifiers do not change merely
   because application code is tagged.
5. Until reviewer approvals are available, the owner runs the existing guarded
   CLI production command for that release tag/SHA, confirms its resolved live
   target/evidence, and dispatches. The workflow retains the credential split,
   canonical lease, migration/recovery checks, immutable plan evidence, paired
   activation, smoke checks, and roll-forward behavior.

An unattended dev/staging preparation job needs administration authority for that
nonproduction environment. Keep its preparation and deployment jobs separately
credentialed and transfer only the immutable prepared artifact; production's
administration key remains absent from Actions. This nonproduction automation
boundary needs an ADR before the workflow is enabled.

Release-please releases or PRs created with the default `GITHUB_TOKEN` do not
normally trigger follow-on workflows. Choose an explicitly scoped GitHub App or
PAT for release automation if relying on `release: published` and release-PR CI;
do not assume those workflows will fire. The initial production release event
should validate eligibility and expose the owner command, not deploy automatically.
[release-please action](https://github.com/googleapis/release-please-action),
[GitHub release events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)

## Implementation sequence and review gates

1. Record the environment/credential boundary ADR with D1–D6 and the D2 manual
   production limit. Update #151's acceptance criteria to distinguish automatic
   dev/staging from owner-confirmed production promotion.
2. Add one validated environment-target module and Wrangler environment blocks;
   derive CLI URLs, provider inventories, release configs and scratch naming from
   that module. Reject missing environment bindings, shared D1/R2 identities,
   cross-environment service targets, and production URLs paired with other keys.
3. Parameterize the prepared release protocol and canonical lease ownership while
   preserving server-owned validation from #111. Add two-environment contract
   tests for plan/digest substitution and ensure the D1 release phase works before
   a compatible Worker is present. Validate JSONC through the shared reader.
4. Provision dev/staging after quota and credential prerequisites are resolved.
   Store resource IDs in config and secrets through the credential manager. Run
   read-only target preflight and local dry-runs before enabling deployments.
5. Add the automatic main-CI-success → dev → staging workflow with per-environment
   serialization, exact-SHA evidence and staged failure propagation. Exercise an
   actual migration and full staging smoke, then a backup/recovery rehearsal.
6. Add pinned release-please configuration and release eligibility handling with
   a token that supports follow-on CI. Prove a release PR receives checks and the
   resulting tag maps to a successfully rehearsed SHA before owner promotion.
7. Update operator runbooks, CLI environment examples, and README from the shipped
   commands; complete the full local gate and independent Standards/Spec review.
   Live acceptance remains open until the real workflows and isolated bindings
   have been observed successfully.

The current map's next owner inputs are confirmation of the Workers plan/headroom,
restored Actions capacity, and ultimately the explicit Go-Live call. No production
reset, subscription change, new credential grant, or deployment is part of this
read-only revisit.
