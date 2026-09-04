# Reconciliation Context

A Reconciliation Context binds an Ingestion Run's outcome to every Source
Observation Set, Source Snapshot, and Source Lineage read during reconciliation.
`reconciliation_contexts` stores only the per-run digest anchor;
`reconciliation_evidence_partitions` owns all evidence identities. No partition
is primary. Candidate inspection and publication derive selected lineages from
those partitions, including partitions whose observation sets are empty.

Reviewable and blocked reconciliation outcomes write their digest anchor and
partitions in the same guarded atomic batch. Publication reads the reconciliation
instant from the run and evaluates adapter capabilities across every partition.

Migration 0010 discards the old context rows and removes their three redundant
evidence columns, as authorized before Go-Live by ADR 0008 and issue #117. New
digest anchors retain their per-run foreign key and immutable update/delete
guards.
