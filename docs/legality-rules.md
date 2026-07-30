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

Their JSON document contains `cards`, `legality_rules`, and
`legality_completeness`. Each rule retains its official identity, exact
wording, game, region, format, nullable event tier, effective interval,
affected Card Numbers, normalized effect, and `representable: true`.

Supported effects are `eligible`, `ban`, `copy_limit`,
`prohibited_combination`, `membership`, `rotation`, `release_timing`, and
`unresolved`. Unknown fields or effects, invalid intervals, conflicting
regions, missing Cards, duplicate rule identities, and
`representable: false` block the selected Ingestion Run before approval.
The prior regional rule set is not carried forward after a valid complete
empty rule stream.

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

Omitting `--region` returns each applicable regional result separately.
Every result includes the applicable Legality Rule IDs and an auditable
derivation. `Catalogue Export` component `legality-rules` contains the
external rule records, with `legality-rule-card` relationships in the
`relationships` component. Newly generated exports use schema major 2 and
retain each rule's complete normalized `effect`, including every operand and
unresolved reason. Historical schema-major-1 artifacts remain immutable and
readable.

Migration `0008_legality_rules.sql` adds canonical provenance retention and
the revision-scoped rule snapshot used by the API. Apply it before deploying
either Worker.
