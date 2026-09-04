# ADR 0012: Official Source adapters fail closed on unproven evidence

Each registered Source Adapter Version defines the exact Official Source authority,
request surfaces, parser, and completeness requirements for its Source Lineage.
Unexpected structure, missing required surfaces, unresolved required identity, or
unverified retained bytes block reconciliation or publication instead of being
interpreted as an empty authoritative result. Adapter changes carry representative
retained-byte and failure-case tests.

Source Adapter Version compatibility follows ADR 0004 from Go-Live; before then,
ADR 0008 permits editing the single current definition in place and regenerating
its data. Synthetic adapters belong to test composition and do not extend the
shipped Official Source authority.
