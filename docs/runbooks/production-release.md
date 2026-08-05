# Guarded Production Release

`keepr release production` is the only general production mutation path. Pull
request and `main` CI run validation and local Wrangler dry-runs only. The
manual `production-release` workflow is serialized, uses the protected GitHub
`production` environment, and is the only workflow that reads Cloudflare
deployment credentials.

## Prepare

1. Confirm GitHub's `production` environment reviewers, branch policy, and the
   Cloudflare deployment token's least-privilege grants outside the repository.
2. Run `npm test`, `npm run typecheck`, `npm run types:check`, and
   `npm run deploy:dry-run` at the exact Production Release SHA.
3. Run `keepr status --json`. Production Release preflight must report the expected
   schema level, idle mutation state, a verified current-revision backup and
   usable bookmark, complete current-plus-two export/recovery evidence, exact
   production bindings, and representative smoke targets.
4. Copy the complete confirmation JSON printed by a deliberately unconfirmed
   command. Do not edit or reorder it. Supply the GitHub Actions-write token in
   `KEEPR_GITHUB_RELEASE_TOKEN`; deployment credentials never enter the CLI.

```sh
npm run keepr -- release production \
  --release-id release-2026-08-05-01 \
  --expected-current-revision catrev_example \
  --expected-head-sha 0123456789abcdef0123456789abcdef01234567 \
  --expected-migration-level 19 \
  --idempotency-key release-2026-08-05-01 \
  --environment production --yes --confirm "$EXACT_CONFIRMATION" --json
```

Exit `10` means GitHub accepted the immutable request; it does not mean the
Production Release succeeded. Inspect the workflow and the durable `production_releases`
record for terminal evidence.

## Production Release behavior

The workflow rechecks the SHA, actor, complete target digest, current Catalogue
Revision, migration level, idle ingestion, recovery evidence and retained
revision window before mutation. It acquires the D1 Production Release lease, applies only
checked-in forward migrations, uploads tagged immutable Worker versions,
activates the API and ingestion pair, observes the resulting binding, and runs
black-box health/auth/revision/Card/Printing/search/Legality Status/export/image
checks. Current and two predecessor export packages must remain queryable;
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

Repository tests cannot prove GitHub reviewer policy, organization workflows,
live secret scope, token grants, D1 location/bookmark usability, R2 public
access settings, traffic propagation, or production observability acceptance.
Verify these in GitHub and Cloudflare before approving the workflow run and
retain the resulting run, deployment/version IDs, logs, and Production Release evidence.
