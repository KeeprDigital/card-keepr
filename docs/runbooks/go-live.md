# Runbook: the first Go-Live release

Status: prepared for #136; the owner has not declared Go-Live. Do not merge the
baseline fold or mutate production until that explicit decision is recorded.
This release ends ADR 0008's exception and starts immutable definition retention.

## Reviewable change

The draft folds the final level-13 chain from
`23b1b1128cf9bf5827034d15dcaebf1964ce7c76` into `0001_baseline.sql` at level 1.
Schema, seeds and trigger-order equivalence are proven in
`acceptance/schema-baseline.test.mjs`; the sole excluded schema artifact is an
empty, unused SQLite internal sequence table. The baseline has 105 immutability
triggers and six production adapter registrations. Test fixture registrations
remain outside the production migration path.

Keep existing identifiers, including `one-piece-en@6`,
`card-keepr-catalogue-export-manifest@5`, and existing cursor/Game Profile `@1`
identifiers. This continues ADR 0008's frozen-identifier decision without a
renumbering migration or changing the bytes' contract identities.

## Prerequisites and owner decision

- Finish the #155 backlog and resolve #151's environment promotion decisions and
  live rehearsal. Its provisional D6 requires this before Go-Live.
- Restore Actions capacity and obtain successful required CI checks for the exact
  release SHA. #155's full local gate authorizes merges only; it does not waive the
  production release workflow's CI gate.
- Verify the selected account, two Worker names, routes, all private buckets,
  database bindings, secret inventory and recovery capacity. Resolve the GitHub
  production environment branch policy required by the release runbook.
- Record the owner's explicit decision that this is the first Production Release
  serving Catalogue Consumers, the approved reset scope, exact SHA and release ID.
  A general request to clear the backlog is not that decision.

## Execute the approved cutover

1. Record the old production database identity and retained evidence. Create a
   fresh production catalogue database with enough quota for the old database to
   remain available until acceptance. Never apply the new baseline over the old
   schema, delete the old database to make room without separate authorization,
   or mark the rewritten baseline as already applied in an old migration ledger.
2. Apply the baseline to the empty database through the approved deployment
   procedure and update both checked-in Worker bindings to the same new ID.
   Obtain the exact successful CI SHA after any binding change. Verify schema
   level 1, the baseline digest proof, production-only adapter registrations,
   foreign keys, integrity and expected empty bootstrap state before activation.
3. Follow the [guarded release runbook](production-release.md), including live
   target attestation and exact owner confirmation. The selected bootstrap or
   ordinary release mode must match live status. Keep the existing canonical
   lease, credential split and smoke gates; the database recreation does not
   authorize bypassing them.
4. Regenerate catalogue data with the active Official Source adapters and publish
   through ordinary approval. Bootstrap Mode only relaxes data-dependent gates
   while empty; it is not evidence that the first consumer release is ready.
5. Before exposing Catalogue Consumers, verify current-plus-two Catalogue Revision
   retention, available verified exports and recovery manifests/bookmarks for the
   retained window, and a successful restore drill. Use
   [backup and recovery](backup-recovery.md) and retain the exact evidence with
   the release. Catalogue Revision retention was never suspended by ADR 0008.
6. Record the actual cutover date in ADR 0008 as “superseded at Go-Live on DATE”,
   reconcile ADR 0006's status with the frozen baseline, and confirm that the
   glossary and ADRs 0001–0004 apply without the pre-Go-Live exception. Attach
   the owner decision, target IDs, release SHA, CI run, paired Worker version IDs,
   baseline/schema level, smoke results and recovery evidence to #136.

Do not close #136 or declare the service live until every step has observed
completion. Keep the prior database until the owner's cutover acceptance; its
later deletion is a separately authorized cleanup action.

## After Go-Live

Never edit the baseline, existing Source Adapter Versions or their Request
Capacity. Use guarded forward migrations, new adapter registrations, separately
named export schema majors and the
[one-predecessor retirement procedure](adapter-version-retirement.md). Retained
schema majors remain readable. Application release tags do not renumber those
contract identities.
