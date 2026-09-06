# Inspect and resolve canonical source mappings

Card and Printing IDs are opaque allocations retained in D1. Their allocation
keys are lookup evidence, never consumer identity. Existing published IDs survive
migration. Candidate preparation retains source mappings; an allocation or an
owner identity decision does not approve or publish a candidate.

Use authenticated owner administration:

```sh
keepr identity inspect --identity-id printing_ID --json
keepr identity reviews --run-id run_ID --json
keepr identity resolve --review-id identity_review_ID --printing-id printing_ID \
  --rationale "Evidence inspected and why it establishes this issued Printing" \
  --idempotency-key UNIQUE_KEY --yes --json
```

Inspection and review lists return `next_cursor`; pass it with `--after` to read
the next page. Review evidence identifies the retained incoming source snapshot,
observation and candidate Printing IDs. Inspect each candidate ID's mappings and
retained depictions before selecting one. A decision selects only an existing
candidate; it cannot merge published identities, create a supplemental entity,
change card facts, override contradictory evidence, or approve a Catalogue
Candidate. Those remain separate operations. Decisions are immutable and replay
with the same request. They require collection, recovery and release mutation to
be idle. Retry collection after resolving a blocked run; the new reconciliation
uses the decision only for the same semantic evidence and an eligible target.

Automatic cross-source matching requires the same noncontradictory Card and
Printing facts. One Piece requires an explicit publisher artwork identity with a
front role; Fusion World requires front/back roles for Leaders and front for
other families; Digimon requires its front depiction. Gundam retains its English
regional Product corroboration policy. Adapter-local artwork labels and image
bytes are insufficient across independent sources. If a source uses different
artwork labels for an otherwise plausible existing Printing, evidence remains
blocked for owner review. Changed URLs and re-encoding alone never establish a
new issued variant. Canonical unknown numbers use
`{"kind":"unknown","value":null}`; the internal query sort key is not a
publisher number. Equal names, rules and profile fields on an unnumbered incoming
Card discover possible matches; they do not establish Card equivalence. An
existing same-Printing mapping or sufficient same-Printing evidence is required,
otherwise the owner must resolve the retained review before publication.

The new allocation, source mapping, review and decision tables are operational
D1 data and therefore part of complete D1 backup/recovery. They are not consumer
export records. Complete composed-catalogue restoration is the separate recovery
ticket's integration gate.

## Validation evidence

The Fusion World CLI replay and cross-source authority/review tests use explicitly
synthetic source fixtures. They prove application behavior, not real-source
coverage. The retained real-source pack from issue #219 remains independently
replayable with `node scripts/source-evidence/replay.mjs`. Its P-001 Bandai and
Limitless base pair was visually reviewed: matching printed markings and artwork,
with distinct PNG/WebP representations. That is evidence supporting an owner
mapping decision, not a generic image-byte equality rule or complete-game claim.
Supplemental-only admission and correction/merge/split actions are outside #221.

Oversized mapping evidence retains a content digest and immutable observation,
observation-set and snapshot references. The original source evidence stays in
retained storage; semantic compatibility remains inline for subsequent matching.
