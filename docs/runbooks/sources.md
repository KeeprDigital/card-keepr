# Sources and owner decisions

Use `pnpm run keepr` from the repository root (shown as `keepr` below), with the
ingestion URL and administration key configured as in [setup](../../README.md).
Commands and input shapes are defined by the
[administration contract](../../contracts/ADMINISTRATION.md).

## Select and collect evidence

```sh
keepr source registry --json
keepr source authorities --json
keepr source collect --plan-file docs/examples/one-piece-two-source-plan.json \
  --idempotency-key CAPTURE_INTENT --json
keepr source show --run-id RUN --json
```

The [example plan](../examples/one-piece-two-source-plan.json) selects required
Bandai P-001 catalogue/event corroboration and Limitless P-001 evidence. Its
completeness is confined to those named source scopes, not the entire game.
Use only subsets declared by the installed registry. Set each source's `required`
or `optional` participation before starting; retry preserves the plan.

Source registration and network access do not designate fact authority. Inspect
the current generation before an explicit scoped change:

```sh
keepr source designate --game one-piece --locale en --release-region OCEANIA \
  --area card_facts --source-lineage limitless-one-piece-en \
  --expected-generation 0 --rationale 'Reason for this source selection' \
  --idempotency-key AUTHORITY_INTENT --json
```

Other areas are `printing_details` and `corrected_card_content`. Authority changes
require idle collection/publication/recovery/release operations. A missing selected
authority cannot silently fall back to another source. Optional availability
outages can carry accepted facts forward with warnings; required capture failures,
identity uncertainty and contradictory evidence still block the refresh.

`source show` reports coverage, request counts, successful check time and actual
content capture time. A partial check never advances successful freshness. A
complete named check can report a Printing no longer observed without deleting it.
An omitted/optional-unavailable scope makes no absence claim.

Use `source lifecycle --lineage LINEAGE` to inspect lifecycle. Retirement or
reactivation uses `source set-lifecycle --lineage LINEAGE --state retired|active
--expected-generation N --rationale TEXT --idempotency-key KEY`. Retirement requires
idle operations and prior revision of affected authority designations; it retains
accepted entities/history and blocks new collection/retry. It is not withdrawal.

## Paused or failed collection

Inspect `collection.actions`, `pause_reason`, per-source capacity/generation,
request and evidence counts, failed images, and Workflow Attempts. Counts are
exact; detail lists may be truncated. A pause keeps retained evidence and the
same run; collection must complete before reconciliation/publication.

| Pause reason                                                                                           | Response                                                   |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `source_request_capacity_exhausted`                                                                    | Extend to the required absolute capacity, then resume      |
| `source_transport_retries_exhausted`                                                                   | Resume after the source recovers                           |
| `source_storage_retries_exhausted`                                                                     | Resume after R2 recovers, including image storage failures |
| `source_workflow_stalled`, `errored`, `terminated` or `unavailable` with the `source_workflow_` prefix | Resume through owner administration                        |
| `owner_requested`                                                                                      | Resume or terminate                                        |

```sh
keepr source capacity extend --run-id RUN \
  --expected-capacity CURRENT --expected-generation GENERATION \
  --capacity NEW_ABSOLUTE_CAPACITY --idempotency-key EXTEND_INTENT --json
keepr source resume --run-id RUN --json
```

Capacity must increase and remain below the global emergency ceiling. Extension
does not resume work. Resume continues retained requests under a new Workflow
Attempt and bounded retry generation; it never renews completed capture work.
If `collection_workflow_supersession_pending` reports a live or unreadable prior
attempt, keep the run paused and retry the same resume after the control plane
recovers. Pacing and Retry-After waits are not stalls.

Stop a collecting run through its lifecycle, rather than terminating provider
instances directly:

```sh
keepr source pause --run-id RUN --idempotency-key PAUSE_INTENT --json
keepr source terminate --run-id RUN --idempotency-key TERMINATE_INTENT --json
```

Termination preserves evidence, fences late work and releases its reservation.
A terminated/failed run cannot resume; `source retry --run-id RUN
--idempotency-key NEW_INTENT` creates a linked run. Integrity failures such as
malformed discovery, identity collision and contradictory required surfaces are
terminal rather than retry pauses.

Image transport failures retain an explicit gap and permit collection to continue.
`collection.failed_images` names unavailable/rejected/redirected/body-invalid
requests; candidates carry `printing_image_unavailable`. They publish without
those images. Collect again after recovery. Storage retry exhaustion still pauses
the run. Redirects are never followed as if they were the original evidence.

## Resolve an uncertain existing identity

```sh
keepr identity inspect --identity-id PRINTING --json
keepr identity reviews --run-id RUN --json
keepr identity resolve --review-id REVIEW --printing-id PRINTING \
  --rationale 'Evidence establishing this issued Printing' \
  --idempotency-key IDENTITY_INTENT --yes --json
```

Follow `next_cursor` with `--after`. Inspect candidate mappings and retained
images before selecting an eligible existing identity. Matching names, rules,
image bytes or changed URLs alone do not prove the same Printing. The decision
cannot create an entity, merge published IDs or override contradictory facts.
Resolve with mutation idle, then retry the blocked collection. Decisions retain
the exact semantic evidence and do not approve publication.

## Admit missing real entities

```sh
keepr entity-proposal create --proposal proposal.json --yes --json
keepr entity-proposal list --game one-piece --json
keepr entity-proposal inspect --proposal-id PROPOSAL --json
keepr entity-proposal admit --proposal-id PROPOSAL --decision decision.json --yes --json
```

The proposal contains `game`, `source_lineage` (`owner` for personal intake),
stable source `reference`, `content`, `evidence` and `idempotency_key`. Use normalized
Card and optional Printing shapes without canonical IDs, at most 64 KiB. Unknown
numbers use `{"kind":"unknown","value":null}`. Personal evidence records specific
observations in `evidence.attestation`; retained captures reference their real
snapshot/observation identities.

Decisions contain decimal-string `expected_generation`, `rationale` and
`idempotency_key`. `admit`, `link`, `reject` and `reconsider` share the command
shape. Linking names an existing `card_id` or `printing_id`; a new Printing can
be admitted under an existing `card_id`. Known numbered Cards cannot be duplicated.
An exception adds `exception.scope` (only needed `source_evidence`/`identity`
scopes) and a specific `exception.attestation`; it cannot waive game structure or
an identified Card. Required evidence contradictions block publication.

Reconsideration can append content/evidence but never rewrites initial intake,
rejection history or allocated IDs. Inspection history uses `--after-generation`;
lists use `--after`. Changed keys/generations conflict. Unresolved proposals may
be excluded with warnings if remaining relationships are consistent.

Admission affects a fresh reconciliation. If an older sealed candidate holds the
game slot, retain its inspection then use `game-candidate abandon --candidate-id
CANDIDATE --generation N --idempotency-key KEY --yes` before preparing again.
A retained source fixture or a visual finding never silently installs an owner
attestation. The [real-source pack](../../acceptance/fixtures/real-sources/2026-09-06/README.md)
describes the bounded P-001 evidence and its limits.

## Correct published identities or facts

For a merge/split, first admit and publish any replacement entities. Create a JSON
proposal with `game`, `entity_kind`, `action`, `source_ids`, `replacement_ids`,
`printing_assignments`, `expected_current_revision_id`, `rationale` and
`evidence.attestation`. A merge has one survivor. A split has one source and at
least two replacements; a Card split assigns every affected Printing explicitly.

```sh
keepr identity-correction validate --proposal correction.json --json
# Add the returned review_digest and a fresh idempotency_key to the proposal.
keepr identity-correction create --proposal correction.json --yes --json
keepr identity-correction inspect --correction-id CORRECTION --json
keepr identity-correction list --game GAME --json
```

Validation binds current entities, relationships and preceding decisions. A changed
revision needs revalidation. One review permits 100 IDs per side, 1,000 Printing
relationships, 64 KiB input and 256 KiB retained review. A later Printing under a
split Card remains excluded until an `assign` decision maps its ID to an existing
replacement; at most 100 assignments per such decision. Consumer-owned copies
are never assigned automatically.

Reconcile and approve a new candidate to publish the decision. Old revisions stay
unchanged. Retired identity reads expose a survivor or all split replacements;
consumers must choose at an ambiguous split. Corrections never reactivate an old
identity silently.

Use `curated-revision validate` then `create` for exceptional existing facts,
with the exact proposal digest and current revision. `reaffirm`, `supersede` and
`retire` are explicit lifecycle actions; a changed overridden source field needs
reconfirmation. See the [administration contract](../../contracts/ADMINISTRATION.md)
for confirmation flags and request shapes. Identity correction and Curated
Revision decisions remain separate from whole-candidate publication.
