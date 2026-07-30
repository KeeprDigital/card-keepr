# Use Catalogue Export schema v2 for exact Legality Rule effects

Catalogue Export schema v1 can identify only a broad Legality Rule kind, so it cannot represent membership predicates, release dates, unresolved reasons, or other rule operands without losing semantics. Newly generated exports therefore use manifest and record schema major 2 and retain the complete normalized discriminated `effect`; existing v1 manifests and objects remain immutable and readable through the same revision-addressed API.

## Consequences

The serialization profile remains `card-keepr-ndjson-gzip@1`, but Catalogue Consumers must select record schemas from each manifest rather than assuming schema major 1. The v1 schemas remain checked in because historical export artifacts are never rewritten.
