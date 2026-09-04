# ADR 0009: Separate catalogue reads and administration into two Workers

The API Worker serves authenticated catalogue reads; the ingestion Worker owns
administration, ingestion, publication, and recovery. Separate bearer credentials
and resource inventories keep evidence and backup access off the public API
runtime. D1 and R2 bindings are resource-scoped, so this boundary combines the
smaller API binding set with read-only routes rather than claiming that a binding
itself restricts writes.

Both Workers share the domain implementation in `src/catalogue` and are activated
as a verified pair through the guarded Production Release. Their public mounts
follow ADR 0007.
