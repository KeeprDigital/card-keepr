# ADR 0003: Unresolved target scope requires export schema major 5

## Status

Superseded for the planned pre-Go-Live replacement by [ADR 0014](0014-card-content-without-tournament-eligibility.md): tournament eligibility and its unresolved-scope processing are outside the catalogue. The body below records historical implementation behavior, not a requirement for the replacement contract.

Accepted. The retention of earlier majors applies from Go-Live only (ADR 0008); before Go-Live the export schema is edited in place and earlier majors are deleted.

## Context

Bandai's 2026-07-24 Gundam policy restricts an open predicate: every current
and future "Unit card that is Lv.2 with cost 1, 2 AP, and 2 HP, and without
effects" participates in banned pairs and a four-copy limit. The publisher
enumerates today's matching cards but explicitly extends the scope to
unenumerated printings. Compiling the enumeration into explicit pair rules
would serialize invented precision; failing closed terminates every
production run for the lineage. Neither outcome represents what the
Official Source actually published.

## Decision

The Legality Rule unresolved-scope vocabulary gains a third dimension,
`target_scope`, alongside `effective_interval` and `event_tier`. A rule
carrying it must use the `unresolved` effect and retain at least one
explicitly enumerated Card; the dimension declares that the Official Source
scope extends beyond that enumeration. Dimension arrays remain unique and
canonically ordered (`effective_interval` < `event_tier` < `target_scope`).

Contextual status treats a target-scope rule as an explicit uncertainty for
every Card of its game, region, and format: publication materializes one
`all_cards` applicability row in addition to the enumerated per-Card rows,
and a status query overlapping the rule answers `indeterminate` with the
rule retained in `unresolved_scope_rule_ids` and the audit derivation.
Definitive rules still decide their own outcomes; the uncertainty is
retained, never silently dropped.

Because the checked-in major-4 record schema pins the exact set of
unresolved-scope dimension combinations, newly generated Catalogue Exports
use manifest and record schema major 5. Major 5 admits every canonical
dimension combination including `target_scope`; `effective_interval`
membership still forces null effective dates, `event_tier` membership still
forces a null event tier, and `target_scope` adds no field constraint of its
own. The checked-in major-3 and major-4 schemas remain byte-identical, and
retained exports continue to be decoded and verified with their recorded
schema major and URIs.

## Consequences

Open-predicate publisher policy parses into an exact retained rule instead
of terminating the run, and the missing precision is explicit at every
boundary: the rule document, the export record, the applicability index, and
the contextual status answer. Consumers must support major 5 before reading
newly published exports. Historical major-3 and major-4 artifacts remain
readable through their explicitly versioned schemas.
