# Fresh-baseline Production Release handoff — prerequisite implementation

Status: prerequisite implementation for #239, reconciled from draft PR #204 at
`da3952fa4fb75903ec8bd34f851fb24e07469470`. The proposal below remains the design
record; the implementation checkpoint and runbook identify executable behavior.
No prerequisite live release, final fold, cutover readiness or Go-Live is claimed.
The source baseline for this work is main `ea51172a27ec525be577553482a41304fa9333c0`
(schema 24: native compositions/recovery and non-expiring storage tickets).

## Implementation checkpoint

The owner preparation and existing guarded release workflow now support a distinct
`fresh_baseline_handoff`. It binds the observed complete source target, source
revision/schema and recovery/retention evidence, exact release SHA and actor,
distinct destination D1 ID, baseline SHA-256, destination level 1, and regeneration
scope. Worker names, routes, accounts and buckets remain the configured source
contract. The destination binding is derived by changing only the catalogue D1 ID.
The actual final fold remains #136; the release branch refuses a migration
directory containing anything except the exact approved `0001_baseline.sql`.

`fresh_baseline_handoffs` owns durable negative mutation authority. The original
canonical lease and a per-execution identity separately authorize progress. A
restart renews the exact matching release; another execution must wait for lease
expiry. An expired or replaced execution cannot advance a phase. Neither expiry,
the generic failure handler nor a stale lease cleanup clears the durable fence.
Phase evidence is appended in order and preserved through SQL restoration.

Source claim atomically rechecks normal source gates, exact preparation, storage
quiescence and the canonical lease. Outstanding evidence PUT tickets, evidence
DELETE claims, staging PUT/DELETE tickets, collection reservations, active
reconciliation/publication/backup work, and search reconstruction block claim.
Schema triggers prevent new canonical writers and ticket admission after claim;
HTTP mutation requests receive an inspectable 409. Status remains readable.

The destination is independently installed and compared against the exact local
baseline's schema and seeds, with integrity, foreign-key and Spine Revision
checks. Transfer copies only automatically validated preparation/control evidence
fetched from the source. It does not copy a migration ledger or invent a backup,
recovery operation, catalogue identity, or published composition. Existing source
Catalogue Revisions, identity/decision history, native composition roots, SQL
recovery authority and R2 objects stay intact in the retained source database.
Fresh catalogue content still requires collection, reconciliation and approval.

Both activation intents bind the same uploaded immutable version pair before any
activation request. Provider observation checks active deployment IDs, 100%
traffic allocation, each active version's complete bindings, and configured zone
routes. Reduced authenticated smoke establishes an empty destination only.
Source retirement is durable before destination acceptance releases its lease.
Destination cleanup remains conservatively fenced against shared R2 objects
owned by the retained source, including after restart/restore. This is evidence
retention, not a legacy parser/schema compatibility path. Deleting retained
resources or relaxing that protection is separately authorized work and is not
an automatic consequence of this handoff.

Before either activation intent, the owner may separately confirm cancellation
through the same CLI/API. The server records immutable cancellation authority;
the workflow proves both active Workers still match the source configuration,
quarantines any transferred destination first, then reopens the source. Any
activation intent requires roll-forward instead. A cancelled destination is never
reused. A corrected SHA/destination before activation requires cancellation and a
new owner-confirmed preparation; after activation, the same confirmed execution
can resume, while a different-SHA repair requires a separately reviewed protocol
extension rather than an undocumented bypass.

See [the operator procedure](../runbooks/fresh-baseline-handoff.md) for the supported
commands, local proof scope and remaining live gates.

## Reviewed proposal (retained design rationale)

The following is the reviewed #204 proposal. References to proposed/unimplemented
seams describe its historical state; the checkpoint above reconciles the schema24
implementation, explicit execution renewal, and conservative retained-source
storage protection.
## Why a distinct handoff is needed

The current release protocol authenticates dispatch against immutable preparation
in the deployed ingestion Worker's D1. Changing checked-in bindings to a fresh D1
makes the workflow query a database without that preparation. Bootstrap Mode
relaxes data-dependent checks for an already-bound empty catalogue; it neither
transfers preparation authority nor permits a replacement recovery handoff.

No guarded reset-in-place implementation exists. Erasing the old schema would
erase the prepared request and canonical Production Release lease while deployed
Workers still depend on that schema. Preserving control records outside the reset
would itself require a new protocol and would sacrifice the intact old database.
Prefer a distinct fresh-baseline handoff that retains the old D1. Do not forge
ledger rows, directly deploy around the guard, or invent replacement recovery
evidence for a database that was not restored.

## Delivery order and the single Go-Live freeze

1. Implement and independently review the protocol against the existing migration
   chain. Deploy that prerequisite through an ordinary guarded Production Release
   so the old Workers can prepare the new request and enforce its durable fence.
   This release does not fold the baseline, supersede ADR 0008, start definition
   retention, or expose Catalogue Consumers.
2. Prove the deployed preparation interface, schema and mutation guards support
   the handoff. If the live schema cannot reach the prerequisite through supported
   guarded forward migrations, stop: that is a separate compatibility blocker,
   not permission to reset it manually.
3. Refresh the #136 baseline fold from the final prerequisite chain and prove
   schema, seed and trigger-order equivalence. The current draft's chain SHA and
   digests cannot be treated as final after protocol changes.
4. After the owner's explicit decision, execute the one Go-Live freeze release:
   exact baseline, identifier decision, reinstated definition retention and ADR
   status changes travel together. Regenerate and approve Catalogue Data and
   verify recovery evidence before exposing Catalogue Consumers. Installing an
   empty database or passing reduced smoke does not itself complete Go-Live.

The prerequisite protocol release enables that single freeze release; it does
not split the freeze across releases or authorize an earlier consumer launch.

## Proposed preparation interface

Add a distinct fresh-baseline handoff choice to guarded Production Release
preparation. The following are proposed facts, not an existing wire contract:

- Source: the server-observed complete Production Target, current Catalogue
  Revision and schema level.
- Destination: the exact approved D1 identity and complete resulting Production
  Target. Initially permit only a D1 identity change within the same account,
  retaining Worker names, routes and buckets.
- Release: exact SHA, actor, release ID, idempotency key, baseline file SHA-256,
  destination schema level 1 and explicit fresh-database reset scope.

The server's exact confirmation and immutable prepared request must bind all
these facts; its dispatch digest covers the entire canonical request. An existing
key with different facts rejects. The old catalogue's preflight and the new
catalogue's empty Spine Revision state are separate assertions. Do not label a
populated source as Bootstrap Mode to skip its safety checks.

The CLI remains a thin administration client and GitHub dispatcher. Administration
credentials stay with it; deployment credentials stay in the protected workflow.
The workflow retains exact-SHA CI, actor, account, secret inventory and target
checks. It must verify the new D1 separately rather than changing the source
configuration before authenticating preparation.

## Durable phases, authority and failure behavior

Reuse the immutable administration ledger pattern used by Bootstrap Mode for
cutover phase facts, bound to the exact prepared request and dispatch digest.
Named repository guards must reject conflicting phase evidence and validate each
predecessor. The proposed sequence is:

| Phase | Required evidence and behavior |
| --- | --- |
| Prepared | Immutable owner-confirmed request exists only in the source D1. Preparation alone does not acquire a lease. |
| Claimed | Recheck the source's live gates and acquire its canonical Production Release lease. Install a durable cutover mutation block atomically with claim evidence. |
| Destination verified | Verify the distinct approved destination is empty, apply only the exact checked-out baseline, then check schema, seeds, foreign keys, integrity and Spine Revision state. Record the result against the source claim. Never apply this baseline to the source. |
| Transferred | Read exact preparation and claim evidence directly from the source using the workflow credential. A closed transfer module validates those bytes and installs matching immutable preparation, cutover evidence and the same release reservation in one guarded destination batch. Exact replay succeeds; conflicting or foreign records reject. Recheck the source fence before proceeding. |
| Activation intended | Persist the intent on both databases before the first activation request. Verify both uploaded versions against the approved destination configurations. Failure to persist either intent prevents activation. |
| Binding observed | Observe both activated Worker versions and their exact destination bindings; deploy and verify routes and run the applicable smoke checks. A partial or uncertain result cannot advance. |
| Handoff accepted | Record matching terminal evidence in both databases. Permanently retire the source's mutation authority before releasing the destination's cutover block and lease. This operational handoff permits ordinary regeneration; it is not the owner declaration that Go-Live acceptance is complete. |

Source and destination operations are separate guarded transactions. Every
intermediate state must therefore remain safe when the workflow stops between
them. Retain the canonical lease identity across transfer and fence renewal and
cleanup against the exact owner. A lease timeout is not cutover cancellation.

**Both D1s need a durable mutation fence that outlives lease expiry. This cannot be
a script-only change.** Runtime administration writers, Workflows and scheduled
maintenance must reject mutations while the relevant cutover remains unfinished;
the source remains retired after acceptance. Only narrowly defined handoff
transitions may advance those records. Do not misuse a recovery operation or
restore evidence to obtain this block. Status must expose enough phase and target
evidence to diagnose and resume it.

Before activation intent, guarded cancellation may release the source only after
proving neither Worker uses the destination; preserve or quarantine the unused
destination. Partial baseline application is inspected or retried through the
reviewed protocol, never made to look complete by editing the migration ledger.
Once any activation intent is durable, failure or uncertainty keeps both mutation
blocks and requires guarded roll-forward and binding observation. Never infer
that a failed request means no Worker activated. A correction that changes SHA or
target needs fresh exact owner confirmation linked to the unfinished cutover.
Cleanup must not reopen either database merely because a lease expired or a
failure handler ran. Later deletion of the retained old D1 is separately
authorized cleanup.

## Implementation seams

Paths below name existing modules; the fresh-baseline behavior is not implemented.

- `src/catalogue/ingestion/production-release-preparation.ts`,
  `production-release.ts` and `production-release-repository.ts`: resolve owner
  choices, preserve exact confirmation/idempotency, and implement typed phase
  transitions. The preparation module is supplied by #111.
- `src/catalogue/shared/` and mutation repositories: interpret durable cutover
  evidence through named guards. Audit every lease-dependent writer, including
  Curated Revision, ingestion, recovery, publication and background maintenance
  paths. Preparation and status need explicit pending/retired behavior too.
- `cli/production-release.mjs`: transport the new owner choices and confirmation;
  do not duplicate server preflight or SQL validation.
- `scripts/production-release.mjs` and a focused handoff module: distinguish source
  and destination configs, verify the checked-out baseline digest, compile guarded
  phase statements, and transfer only evidence fetched from source authority.
  Borrow the replacement handoff's transport pattern, not its recovery records.
- `scripts/production-release-provider.mjs`: attest both target identities and
  prove the uploaded and activated version pair binds the approved destination.
- `.github/workflows/production-release.yml` and
  `scripts/production-release-failure.sh`: explicit phase-aware source/destination
  execution and restart behavior. Switch the release-state configuration only
  after destination transfer verifies; preserve source access for final retirement.
- `acceptance/schema-baseline.test.mjs`, release acceptance tests and the Go-Live
  runbook: refresh the final fold proof and document only commands proven by the
  implemented protocol. No cutover command is specified in this proposal.

## Required two-D1 acceptance evidence

Use two isolated D1s and the real preparation, compiled query and transfer seams;
do not seed the destination's authority with handwritten fixture ledger rows.
Provider test adapters may control deployment responses while retaining exact
uploaded-version and observed-binding assertions.

- Complete preparation, source claim, baseline installation, transfer, paired
  activation, smoke and handoff acceptance. Assert the source's catalogue and
  evidence are unchanged, its writes stay retired, and the destination can begin
  ordinary approved regeneration only after the handoff completes.
- Reject changed source/destination IDs, account, SHA, actor, baseline bytes or
  digest, populated destination, missing preparation, forged transfer evidence,
  stale source revision, conflicting idempotency and competing releases.
- Interrupt and restart after every phase and between each pair of database
  writes. Prove exact replay, predecessor validation and no duplicate authority.
- Expire or replace the canonical lease; exercise real administration, Workflow
  and scheduled mutation callers on both D1s. An unfinished cutover remains
  blocked and stale cleanup cannot release a newer reservation.
- Exercise failure before activation intent, partial baseline installation,
  one-Worker activation, ambiguous activation response, mismatched bindings,
  smoke failure and terminal-evidence failure. Prove cancellation is restricted
  to its safe phase and all later uncertainty requires roll-forward.
- Keep workflow contract tests for credential separation, exact-SHA CI, source
  preparation lookup, baseline digest validation, route/version verification and
  failure-handler ordering. Preserve ordinary and replacement recovery releases.

Repository tests cannot establish live token grants, environment policies, quota,
DNS/traffic propagation or owner acceptance. Those remain observed prerequisites
of the future guarded execution; this plan does not waive them.
