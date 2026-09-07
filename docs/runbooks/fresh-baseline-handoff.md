# Fresh-baseline authority handoff

This is the prerequisite protocol for #239 and the later #136 freeze. It has not
been released to staging/production. A local successful test is not permission or
proof to perform the prerequisite live release, final fold, production cutover or
Go-Live. Those require the owner's explicit approval and executable live evidence.
The [reconciled proposal](../plans/fresh-baseline-handoff.md) records the design.

## Delivery order

1. Release this protocol and its guarded forward migration through the existing
   pre-fold runtime using an approved ordinary staging/production release. Prove
   the deployed CLI/API preparation, schema and mutation fences. Keep the old D1.
2. Finish the other #216 prerequisites and refresh #136's final fold against the
   actual integrated migration order. Preserve identifiers and prove final schema,
   seed and trigger-order equivalence. This implementation does not edit the
   baseline or enable from-Go-Live version retention.
3. Obtain explicit approval for the exact final cutover. Preserve the complete
   source target configuration in the release checkout. Supply the distinct,
   already-approved destination D1 identity and SHA-256 of the one folded
   `migrations/0001_baseline.sql`. The workflow creates no cloud resources.
4. Run the exact confirmed guarded handoff. After operational acceptance, collect,
   inspect and approve the destination catalogue and verify its backup/recovery
   evidence. Keep the separate Go-Live declaration and enabled-game requirements.

No manual copying into `d1_migrations`, handwritten authority seeding, reset of the
source, direct deployment, or fabricated replacement-recovery evidence is valid.
The source's populated release gates remain active; destination emptiness never
turns a populated source into Bootstrap Mode.

## Owner command

Use the normal production release command with two additional choices:

```text
keepr release production --environment production \
  --release-id <release> --idempotency-key <preparation-key> \
  --expected-current-revision <source-revision> \
  --expected-head-sha <exact-approved-sha> \
  --expected-migration-level <source-level> \
  --fresh-database-id <approved-distinct-d1-id> \
  --baseline-sha256 <sha256-of-final-baseline> --yes --json
```

The first call returns the exact server-resolved confirmation. Repeat the same
command with `--confirm '<exact confirmation>'`. Use `--bootstrap` only if the
**source** is itself provably at the unpublished Spine Revision. Administration
credentials remain in the CLI; deployment credentials remain in the guarded
workflow. The workflow still requires successful exact-SHA release checks,
expected actor/account, private bucket and secret inventories, and serialized
execution. The current choice of local integration checks does not waive these
live release gates.

The workflow authenticates preparation against the source, claims its durable
fence and lease, installs and verifies the approved baseline in the destination,
transfers exact source control evidence, records both activation intents, then
activates/observes the exact pair and routes. Only successful authenticated smoke
and permanent source retirement allow the destination to accept mutation.

## Inspect, resume or cancel

`keepr status --json` reports `fresh_baseline_handoff`, its role, numeric phase,
exact request/digest, append-only evidence, and `mutation_blocked`.

| Phase | Meaning |
| --- | --- |
| 1 | Source claim / transferred destination reservation |
| 2 | Exact fresh baseline verified |
| 3 | Source authority transferred |
| 4 | Activation intended on both databases |
| 5 | Active version pair, bindings, routes and smoke observed |
| 6 | Source retired / destination handoff accepted |
| 7 | Source cancellation accepted / destination quarantined |

Retry the same confirmed dispatch after interruption. Each workflow attempt has
an execution identity; a different execution can take over only after the
45-minute canonical lease expires. Renewal preserves the release ID and exact
prepared request while fencing the superseded execution. Expiry never unblocks
ordinary writes. A lost write response is inspected before replay; a completed
handoff is returned unchanged.

Before any phase-4 intent, safe cancellation is an additional explicit owner
confirmation: repeat the original owner command with `--cancel-fresh-handoff`,
then repeat its newly returned exact confirmation. The source records this intent
before dispatch. Cancellation verifies active source versions/bindings/routes,
quarantines a transferred destination, and only then clears the source lease.
A changed source observation or any activation intent refuses cancellation.
A corrected pre-intent target/SHA requires this cancellation followed by a new
release ID and preparation key. Never reuse a quarantined destination.

After phase 4, failure or ambiguous activation requires the same exact guarded
roll-forward and new binding observation. Neither a generic failure handler nor
lease cleanup may reopen either database. A code defect requiring a different
SHA after activation is a genuine repair blocker: obtain a reviewed, separately
confirmed correction protocol; do not manually rewrite the stored request.
Source retirement is permanent; retained source deletion is outside this command.

## Local proof and live evidence

`acceptance/fresh-baseline-handoff.test.mjs` uses actual SQLite export/import and
the production SQL compiler with separately retained source and fresh target
files. Source preparation calls the shipped domain implementation. It injects
lost responses, expiry, replaced execution identities, provider failures and
cancellation faults. Its provider/smoke responses are explicitly synthetic.

`acceptance/fresh-baseline-owner.test.mjs` exercises the shipped CLI and
production authenticated ingestion/consumer Workers, a native D1 claim, HTTP
mutation denial, separately confirmed cancellation and persisted restart status.
GitHub dispatch and the observation used in its cancellation are local doubles.
`acceptance/production-release-provider.test.mjs` independently checks the actual
provider adapter against wrong active versions, traffic, bindings, routes and
zone identity. None of these tests represents retained real publisher evidence.

The following remain live prerequisites: approved protocol staging/production
release, actual exact-SHA executable release gates, final fold equivalence,
provider installation/restart/interruption observations, retained source recovery
and R2 evidence, destination regeneration/consumer journeys, and explicit Go-Live.
Record exact SHAs, source/destination IDs, dispatch digest, both observed version
IDs, route inventory, terminal phase evidence and verified recovery IDs at actual
execution. Keep readiness false until those observations exist.

Provider contracts used: [D1 query batches](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/),
[Worker deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/),
and [zone routes](https://developers.cloudflare.com/api/resources/workers/subresources/routes/).
