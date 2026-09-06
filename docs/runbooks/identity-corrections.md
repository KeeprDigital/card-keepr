# Reviewed identity corrections

Identity corrections repair published Cards and Printings under issue #223. New
replacement identities must first pass Entity Proposal admission and publication.
Existing-entity fact exceptions continue to use `curated-revision validate`,
`create`, `reaffirm`, `supersede`, and `retire`. A changed overridden source field
requires that explicit lifecycle decision; unrelated source changes do not.
Admission policy changes continue to warn that reassessment is required without
removing an accepted entity or reallocating its ID. Publisher confirmation of an
unknown number remains the separate evidence-matching flow.

Write a proposal JSON object containing:

- `game`, `entity_kind` (`card` or `printing`), and `action` (`merge` or `split`).
- `source_ids` to retire and `replacement_ids`: one survivor for a merge, at
  least two replacements for a split of one conflated identity.
- `printing_assignments`: `{}` except for a Card split, where every affected
  catalogue Printing ID must explicitly map to a replacement Card ID. These
  are catalogue relationships; consumer-owned copies are never assigned.
- `expected_current_revision_id`, `rationale`, and `evidence.attestation` with
  the owner's specific observations establishing the correction.

Run `keepr identity-correction validate --proposal proposal.json --json`. Inspect
the returned retained entity documents and affected Printing relationships, then
add its exact `review_digest` and a unique `idempotency_key` to the proposal. Run
`keepr identity-correction create --proposal proposal.json --yes --json`.
Validation binds the published revision, reviewed entities, relationships and
preceding decision sequence. Concurrent changes require revalidation. Collection,
release and recovery guards remain in force.

Use `identity-correction inspect --correction-id ID` for the complete retained
decision, or `identity-correction list --game GAME [--after SEQUENCE]` to traverse
history. Decisions and source mappings are never rewritten. The correction set,
including an empty set, is pinned atomically with reconciliation request creation.
Replays reuse that set. Recording a decision does not publish it.

Collect and reconcile normally. Candidate warnings identify each correction and
any excluded image, Erratum or relationship whose retired endpoint cannot be
retained consistently. Whole-candidate approval publishes the corrected facts and
replacement links together. Earlier revisions and exports are unchanged. A
later observation of an old identity cannot silently reactivate it.

After publication, requests for a retired Card or Printing return a
`data.type: identity_correction` document with `action` and `replacement_ids`.
A merge exposes `data.links.survivor`; a split exposes all
`data.links.replacements` and does not select or redirect to one variant.
Responses require consumer authentication, carry revision metadata and support
conditional reads. Links may lead to subsequent corrections; consumers must
retain a choice when they reach a split. Ordinary lists and search contain the
remaining entities. Exports with corrections add the optional
`identity-corrections` component, with the same IDs and actions and no owner
evidence, rationale or API-host-dependent links.

Validation evidence is deliberately separated: the new Worker and CLI tests use
synthetic owner attestations. The CLI harness injects successful backup health
so this test isolates correction publication and authenticated consumption; it
is not a recovery rehearsal or a finding about real physical cards.
