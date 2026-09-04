# ADR 0010: Retain evidence identities in D1 and exact bytes in private R2

D1 records source plans, immutable evidence identities and digests, and the
relationships needed to reconcile and publish a Catalogue Revision. Private R2
retains the exact source bytes and backup/export objects; processing verifies
those bytes against the recorded identity before using them. Replay and audit
therefore use retained evidence instead of silently refetching a changed source.

R2 objects alone do not prove a successful publication or restore: the corresponding
D1 evidence and verification must close over them. Current plus two predecessor
Catalogue Revisions retain operational export/recovery evidence; ADR 0008 governs
definition compatibility before and after Go-Live.
