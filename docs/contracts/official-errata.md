# Official Errata evidence contract

Official Errata are accepted only from an **Official Source** through retained
Source Observation evidence. The observation keeps the source-published Card
and Printing facts unchanged; reconciliation derives **Effective Rules Text**
without rewriting **Printed Rules Text**.

The installed One Piece Official Errata adapter is bound to Bandai's documented
English Errata surface:
`https://en.onepiece-cardgame.com/rules/errata_card/`. Requests for that
adapter do not accept substitute HTTPS hosts or paths. Reparse applies the
same exact-surface check to the immutable `request_url` retained with the
Source Snapshot before any bytes are parsed.

The retained Source Snapshot is Bandai's UTF-8 HTML, not a producer-normalized
JSON Card document. The versioned HTML adapter structurally enumerates both
dated detail entries and historical modal entries inside the page's bounded
content region. It requires the dated section or modal heading, Card heading,
correction image, and exact `Before:`/`After:` pair for every enumerated entry;
each field label has exactly one value container. An independent inventory of
Card headings must match the recognized entry containers and parsed
observations. Unique modal-link targets and unique recognized modal fragments
form an exact bijection, so duplicate, missing, orphaned, or newly shaped modal
content fails closed rather than disappearing. Unrelated footer or rules-change
content is excluded. `Note:` fields and common notice qualifiers are retained
with the `Before:`/`After:` fields in source order as `official_wording`; an
unknown field fails closed. Its dedicated Erratum observation keeps the page's
published date separate from `effective_from`: a dated page heading does not
invent an official applicability date, so `effective_from` remains `null`
unless the source explicitly supplies one. `Before:` is observed Printed Rules
Text evidence; `After:` is the correction used to derive Effective Rules Text.

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
- `official_wording` is the complete non-empty correction notice published by
  the Official Source, including modeled qualifiers in source order.
- `corrected_value` is the exact non-empty corrected text, or `null` when the
  Official Source explicitly removes Effective Rules Text.

The dedicated observation never supplies complete Card or Printing facts.
Its target identity is resolved only against the run's expected published
Catalogue Revision: `card` maps an exact accepted official Card identity and
`printing` additionally maps an exact accepted Printing locator. Missing or
ambiguous targets block reconciliation; the Errata surface never creates a
Card or Printing. Provenance records the Source Lineage and Source Observation
identity; neither is supplied by the Erratum object itself.

Publication uses the authenticated reconciliation request time as the
deterministic applicability clock. Approval never recalculates wording. If an
effective date for a selected Supported Game is crossed while a candidate
awaits approval, approval rejects the stale candidate and requires a fresh
reconciliation. Unselected Supported Games carry forward byte-for-byte from
the current Catalogue Revision.

An Errata-only observation advances the Supported Game's `errata` freshness,
not its broader `cards-and-printings` freshness. If a previously published
Erratum from the same Source Lineage disappears from a complete observation,
the immutable Erratum remains published with its prior last-observed revision
and reconciliation emits an `erratum_not_observed` warning.
