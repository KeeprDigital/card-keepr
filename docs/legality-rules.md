# Legality Rules and contextual status

Legality is published as effective-dated `Legality Rule` records. A
`Legality Status` is never stored: the API derives it for an explicit `Card`,
date, region, format, and optional event tier from the current
`Catalogue Revision`.

## Source adapter input

The complete production adapters are:

- `one-piece-json-document@3`
- `fusion-world-en@2`
- `digimon-en@2`
- `gundam-en-asia@2`
- `gundam-en-us@2`

Their JSON document contains a closed `surfaces` object. Every production
adapter requires discovery, Card listing/detail, canonical Card, Product
listing/detail, current Legality Rule, Legality history, and Errata surfaces.
The One Piece adapter also requires block-policy, release-timing, and DON-rule
surfaces. Each surface declares the adapter's exact regional partition, its
total record count, and a complete ordered set of pages; every page declares
its page number, total page count, record count, and records. A truly empty
surface is represented by a declared total of zero and no pages. Non-Card
surfaces prove that a production capture covered the required Official Source
areas; their exact response bytes remain retained Source Snapshot evidence and
are not interpreted as Product or Erratum catalogue records by this feature.
The adapter derives completeness from this structure and rejects missing
surfaces, incomplete page sets, mismatched counts, unexpected partitions, and
unknown envelope fields.

Each rule retains its Official Source identity as `official_id`, exact wording,
game, region, format, nullable event tier, effective interval, affected Card
Numbers, normalized effect, and `representable: true`. Its catalogue `id` is
derived from the canonical pair of `source_lineage` and `official_id`. Once
that identity is observed, identity-bound rule semantics cannot change; the
Official Source must publish a new official identity for a semantic change.

Supported effects are `eligible`, `ban`, `copy_limit`,
`prohibited_combination`, `membership`, `rotation`, `release_timing`, and
`unresolved`. Unknown fields or effects, invalid intervals, conflicting
regions, missing Cards, duplicate rule identities, and
`representable: false` block the selected Ingestion Run before approval.
A complete observation replaces only its own source lineage. Rules missing
from that observation remain in catalogue history as non-current, with their
first-observed, last-observed, and last-missing revisions. Reappearance of the
same unchanged official identity restores it as current while retaining that
lifecycle history.

Gundam `EN-ASIA` and `EN-US` are separate source lineages. Do not ingest or
derive an `EN-OCEANIA` Gundam scope. Rule applicability is determined only by
the published effective interval and requested context; fetch order and
capture recency never establish authority.

## Consumer query

Use authenticated `GET /v1/legality-status` or:

```sh
keepr legality status \
  --card-id CARD_ID \
  --on 2026-07-30 \
  --format standard \
  --event-tier championship \
  --region EN-ASIA \
  --json
```

Omitting `--region` returns every supported regional result separately,
including an `indeterminate` result where no effective published rule exists.
Every result includes the applicable Legality Rule IDs and an auditable
derivation. `Catalogue Export` component `legality-rules` contains the
external rule records, with `legality-rule-card` relationships in the
`relationships` component. Newly generated exports use schema major 2 and
retain `official_id` and each rule's complete normalized `effect`, including
every operand and unresolved reason. Relationship lifecycle states whether a
rule is current and preserves its observation boundaries. Historical
schema-major-1 artifacts remain immutable and readable.

Migration `0008_legality_rules.sql` adds canonical provenance retention and
the revision-scoped rule snapshot used by the API. Apply it before deploying
either Worker.
