# Official Errata evidence contract

Official Errata are accepted only from an **Official Source** through retained
Source Observation evidence. The observation keeps the source-published Card
and Printing facts unchanged; reconciliation derives **Effective Rules Text**
without rewriting **Printed Rules Text**.

The installed One Piece Official Errata adapter is bound to Bandai's documented
English Errata surface:
`https://en.onepiece-cardgame.com/rules/errata_card/`. Requests for that
adapter do not accept substitute HTTPS hosts or paths.

Each Erratum object conforms to
[`official-errata.schema.json`](./official-errata.schema.json):

- `authority` is exactly `official_errata`. No generic source observation or
  Curated Revision silently acquires this authority.
- `field` is exactly `effective_rules_text`.
- `target_type` is `card` or `printing`. A Card target may change the Card's
  Effective Rules Text. A Printing target records the narrower correction and
  never overwrites that Printing's Printed Rules Text.
- `effective_from` is an inclusive `YYYY-MM-DD` official applicability date,
  or `null` only when the Official Source publishes no date. A Catalogue
  candidate evaluates it against the reconciliation clock.
- `official_wording` is the non-empty correction notice published by the
  Official Source.
- `corrected_value` is the exact non-empty corrected text, or `null` when the
  Official Source explicitly removes Effective Rules Text.

The target identity is resolved from the surrounding Source Observation:
`card` maps to its accepted Card identity and `printing` maps to its accepted
Printing identity. Provenance records the Source Lineage and Source
Observation identity; neither is supplied by the Erratum object itself.

Publication uses the authenticated reconciliation request time as the
deterministic applicability clock. Approval never recalculates wording. If an
effective date for a selected Supported Game is crossed while a candidate
awaits approval, approval rejects the stale candidate and requires a fresh
reconciliation. Unselected Supported Games carry forward byte-for-byte from
the current Catalogue Revision.
