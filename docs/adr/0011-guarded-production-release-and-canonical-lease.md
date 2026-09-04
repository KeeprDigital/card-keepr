# ADR 0011: Guard Production Release with exact evidence and a canonical lease

Production Release prepares an immutable request, binds owner confirmation to its
exact target, and dispatches a serialized workflow that rechecks live evidence
before mutation. The operator holds administration and dispatch credentials; the
workflow holds deployment credentials. The confirmation remains the human gate
while the GitHub production environment cannot require reviewers.

A canonical D1 lease fences release mutation independently of Ingestion Run
identity; an expired owner cannot continue its release. Catalogue Recovery retains
its mutation block through verification and owner acceptance, with a narrowly
checked replacement-D1 handoff. Once migration starts, release failure requires
compatible roll-forward. Bootstrap Mode relaxes only evidence that cannot exist
before the first Catalogue Revision, as specified in the release runbook.
