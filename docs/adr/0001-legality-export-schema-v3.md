# Use Catalogue Export schema v3 for exact Legality Rule effects

Catalogue Export schema v2 cannot represent membership predicates, release
dates, unresolved reasons, or other rule operands without losing semantics. It
also leaves a globally applicable rule without a Card relationship unable to
expose whether the Official Source still publishes it. Newly generated exports
therefore use manifest and record schema major 3 and retain the complete
normalized discriminated `effect`, source provenance, and lifecycle directly
on every Legality Rule. V3 also permits a nullable `effective_from` only when
an unresolved rule carries explicit `unresolved_scope` dimensions, preventing
an unknown interval or event tier from being serialized as an invented date or
global scope. Existing v1 and v2 manifests and objects remain
immutable and readable through the same revision-addressed API.

The v3 component schema treats each effect as a closed discriminated shape:
its discriminator fixes the matching export `kind`. An explicit unresolved
scope is valid only for an `unresolved` effect targeting at least one Card.
`effective_interval` uncertainty requires both effective dates to be `null`;
otherwise `effective_from` remains an exact date. `event_tier` uncertainty
requires a `null` event tier. Scope dimensions use the one canonical order,
and prohibited-combination rules retain at least one direct Card as well as
their companion operands.

## Consequences

The serialization profile remains `card-keepr-ndjson-gzip@1`. The canonical v3
manifest advertises `catalogue-export-record@3` schema URIs for every component
so the composition has one unambiguous schema major. Rule records require
`source_lineage`, at least one `source_observation_id`, and the same
revision-bounded lifecycle shape used by relationships. Card-scoped rules
continue to publish `legality-rule-card` relationships as supplemental
navigation evidence. Separately named v1 and v2 manifest and record schemas
remain checked in solely for immutable historical export artifacts; a new v3
manifest never references them.
