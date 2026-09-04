# Guarded Production Release

`keepr release production` is the only general production mutation path. Pull
request and `main` CI run validation and local Wrangler dry-runs only. The
manual `production-release` workflow is serialized, uses the protected GitHub
`production` environment, and is the only workflow that reads Cloudflare
deployment credentials.

## Prepare

1. Confirm GitHub's `production` environment branch policy and the Cloudflare
   deployment token's least-privilege grants outside the repository. This
   repository's billing plan does not support required reviewers on the
   `production` environment, so the exact confirmation envelope the CLI
   demands (step 4) is the only human gate before the workflow mutates
   production.
2. Confirm the public mounts' prerequisites (ADR 0007). Zone routes do not
   create DNS: a proxied placeholder record for `card.keepr.digital` must
   exist in the `keepr.digital` zone (an `AAAA` record to `100::`, proxied)
   before the first release, or the routes never receive traffic. The
   `production` environment secret `API_BASE_URL` must be the public API
   base, `https://card.keepr.digital/api`, because the smoke checks append
   route paths to it.
3. Run `npm test`, `npm run typecheck`, `npm run types:check`, and
   `npm run deploy:dry-run` at the exact Production Release SHA.
4. Run `keepr status --json`. Production Release preflight must report the expected
   schema level, idle mutation state, a verified current-revision backup and
   usable bookmark, complete current-plus-two export/recovery evidence, exact
   production bindings, and representative smoke targets. On an empty
   catalogue it reports `bootstrap: true` instead; see Bootstrap Mode below.
5. Copy the complete confirmation JSON printed by a deliberately unconfirmed
   command. Do not edit or reorder it. Supply the GitHub Actions-write token in
   `KEEPR_GITHUB_RELEASE_TOKEN`; deployment credentials never enter the CLI.

```sh
npm run keepr -- release production \
  --release-id release-2026-08-05-01 \
  --expected-current-revision catrev_example \
  --expected-head-sha 0123456789abcdef0123456789abcdef01234567 \
  --expected-migration-level 1 \
  --idempotency-key release-2026-08-05-01 \
  --environment production --yes --confirm "$EXACT_CONFIRMATION" --json
```

Exit `10` means GitHub accepted the immutable request; it does not mean the
Production Release succeeded. Inspect the workflow and the durable `production_releases`
record for terminal evidence.

## Bootstrap Mode: before the first published revision

A freshly provisioned or recreated catalogue database points at the Spine
Revision `catrev_spine_000` and holds no Catalogue Revision, so nothing the
ordinary preflight demands can exist: no verified backup or bookmark, no
current-plus-two retained window, no smoke targets. Bootstrap Mode ships the
code that publishes the first revision through the same guard instead of a
direct `wrangler deploy`.

1. `keepr status --json` reports `release_preflight.bootstrap: true` exactly
   when the current revision is the Spine Revision and no Catalogue Revision
   has ever been published. The recovery, retention, and smoke fields are
   `null`/`false` and are not required.
2. Add `--bootstrap` to the command in step 5 with
   `--expected-current-revision catrev_spine_000`. The confirmation envelope
   carries `"bootstrap": true` in place of the recovery bookmark and backup
   attempt. A replacement-D1 handoff cannot be combined with Bootstrap Mode.
3. Every data-independent gate still applies and is rechecked live by the
   workflow: exact SHA and actor, complete target digest, migration level,
   idle mutation state and healthy recovery, secret inventory
   (`verify-target`), uploaded-version bindings (`verify-version`), and the
   route triggers. The live gate additionally proves the catalogue is empty.
4. The workflow runs a reduced smoke instead of the data-dependent checks:
   readiness (`/health`) reporting `status: ok` with a valid key on the API
   mount and `401` without one, an unauthenticated `401` from the ingestion
   mount's `/health` (the workflow holds no administration credential; the
   placeholder origin never answers so), liveness (`/healthz`) answering
   `200` without a credential on both mounts, and `/v1/catalogue` reporting
   the Spine Revision.
5. No `production_releases` row is written: its recovery columns presuppose a
   verified backup. The Production Release holds the same lease and keeps its
   phase evidence (`release-deploying`, `release-binding`, `release-smoke`)
   in `administration_idempotency`, keyed by the dispatch digest. A failure
   after migration is retained there too, the fence is released, and there is
   nothing to roll back to; correct it with another Bootstrap Mode Production
   Release.

Bootstrap Mode switches off permanently once a Catalogue Revision is
published. `keepr status` then reports `bootstrap: false`, the CLI refuses
`--bootstrap` with `bootstrap_not_applicable`, the ingestion runtime refuses
to prepare the request, and the workflow's live recheck fails closed. Any
number of Bootstrap Mode Production Releases may run while the catalogue
stays empty, so a provisioned environment never needs a direct
`wrangler deploy`: apply the baseline, set the secrets and DNS placeholder,
run the preflight rehearsal, and dispatch a Bootstrap Mode Production
Release.

## Production Release behavior

`migrations/` is one schema baseline (`0001_baseline.sql`, schema level 1,
ADR 0006) followed by guarded forward migrations. An empty database is
built by applying the baseline; `keepr status` reports the level of the
last applied file, and `--expected-migration-level` must name that level.

The workflow rechecks the SHA, actor, complete target digest, current Catalogue
Revision, migration level, idle ingestion, recovery evidence and retained
revision window before mutation. Every release state statement the validator
generates (`live-preflight.sql`, `claim.sql`, `materialize.sql`, the phase
evidence, and the failure handler's files) runs through
`scripts/production-release-d1.mjs`, which posts the file to the D1 query
endpoint and prints each statement's rows; a remote `wrangler d1 execute
--file` goes through the D1 import API instead, returns no rows, and can make
the database unavailable while it runs (issue #148). Only
`wrangler d1 migrations apply` still runs through wrangler, and the
`production-preflight` rehearsal proves the query path with one read-only
statement. It acquires the D1 Production Release lease, applies only
checked-in forward migrations, uploads tagged immutable Worker versions,
verifies that each uploaded version binds exactly the checked-in vars,
bindings, and expected secrets, activates the API and ingestion pair,
deploys both Workers' route triggers, observes the resulting binding, and
runs black-box readiness/liveness/auth/revision/Card/Printing/search/Legality
Status/export/image checks against `API_BASE_URL`. The readiness check
(`/health`, issue #144) proves the activated version's D1, R2, Workflow, and
version bindings from inside the Worker: a `degraded` document answers `503`
and fails the smoke, so a release that activated with a broken binding never
reaches the smoke-passed evidence. After a release, `keepr health` reads the
same document and exits non-zero while either runtime is degraded, and the
liveness routes (`/api/healthz`, `/ingest/healthz`) are what an external
Cloudflare Health Check watches (see the README health section).

Versions carry code, vars, and bindings, but the zone routes that mount the
Workers at `card.keepr.digital/api` and `/ingest` are script-level triggers
that `versions upload` and `versions deploy` never apply. The workflow
therefore runs `wrangler triggers deploy` for each release configuration
immediately after activation; a route change ships through the guarded
release like any other configuration change.

### Binding inventory checks

Two checks cover the Worker inventory, at different points:

- **Before mutation** (`verify-target`): the D1 and R2 identities and privacy,
  and each deployed Worker's **secret** inventory, which must equal the
  expected set exactly. Secrets outlive versions and are managed by
  operators: a deploy never adds or removes one. When a release removes a
  secret from the expected list, delete it from the live Worker first with
  `wrangler secret delete`; when it adds one, `wrangler secret put` it first.
  Never delete an expected slot: the `*_REPLACEMENT` bearer slots are part of
  the expected set, so change a slot's value by overwriting it.
- **After upload, before activation** (`verify-version`): the version tagged
  `release-<id>-api` / `-ingestion` must bind exactly the vars, D1, R2,
  service, Workflow, and rate-limit bindings of the release configuration
  plus the expected secrets. Vars and bindings therefore change through the
  guarded release like any other change, and the deployed script is never
  compared against a configuration it has not been deployed from.

`workflow_dispatch` accepts at most 25 inputs; a file that declares more is
invalid, GitHub records a failed run on every push to `main`, and no dispatch
can run. The contract test asserts the count. Current and two predecessor export packages must remain queryable;
displacement is blocked without verified export and recovery evidence.

After migration begins, a failure is recorded with
`roll_forward_required=1`. Correct it with a compatible forward Production Release. Do not
roll back a Worker unless its compatibility with the migrated schema has been
separately proven and recorded.

## Replacement-D1 handoff

For a verified replacement recovery awaiting acceptance, add all three:

```text
--replacement-recovery-id <recovery-id>
--replacement-database-id <verified-new-d1-id>
--retained-database-id <old-d1-id>
```

The identities must exactly match the blocked recovery operation. The Production Release
generates ephemeral Wrangler configs binding both Worker versions to the new
D1, deploys the pair, and records an observation through the newly bound API.
It never deletes the old database. Only after that evidence exists may the
owner run the existing guarded `keepr recovery accept` command against the
observed replacement binding. A partial handoff stays blocked and requires a
compatible roll-forward.

## Environment-only verification

Repository tests cannot prove GitHub environment policy, organization workflows,
live secret scope, token grants, D1 location/bookmark usability, R2 public
access settings, traffic propagation, or production observability acceptance.
Verify these in GitHub and Cloudflare before approving the workflow run and
retain the resulting run, deployment/version IDs, logs, and Production Release evidence.
