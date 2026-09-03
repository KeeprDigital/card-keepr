# ADR 0008: Nothing is versioned or retained before Go-Live

## Status

Accepted

## Context

Card Keepr has no Catalogue Consumers yet. The catalogue database was
recreated empty on 2026-09-03 (ADR 0006) and the first production Ingestion
Run started the same day. Despite that, the repository carried every
versioning mechanism a live system needs: five Catalogue Export schema
majors with earlier majors kept readable (ADRs 0001 to 0003), 53 registered
Source Adapter Versions of which 22 are retired registrations and 4 are
parseable predecessors (ADR 0004), a retirement runbook, a retired-runs
query, and tickets that bump a version to change one number.

None of that protects anyone. There is no retained package, snapshot, or
run that a consumer depends on. Each version bump added a registration
row, a schema file, a test pin, and a paragraph of documentation, and the
resulting `@N` identifiers made it hard to see which definition was live.

## Decision

**Go-Live** is the first Production Release that serves Catalogue
Consumers. Until Go-Live, Card Keepr keeps exactly one version of every
definition and retains nothing for compatibility:

- One Catalogue Export manifest and record schema. Changes edit the current
  schema in place. No earlier major is kept readable or checked in.
- One Source Adapter Version per Source Lineage. A parser or policy change
  (including Request Capacity) edits the registered version in place. No
  predecessor is kept parseable and no retired registration is kept.
- One schema baseline. Guarded forward migrations are still how a change
  reaches a database that already exists, but they are folded back into
  the baseline whenever the production database is recreated, and all of
  them are folded in immediately before Go-Live so version one ships with
  `0001_baseline.sql` alone.
- One Game Profile, cursor format, and serialization profile per concept.

Data produced under a previous shape is regenerated (re-run, re-export,
re-baseline), never migrated or kept readable. Identifiers keep their
current `@N` suffix until Go-Live rather than being renumbered, because the
suffix is an identity, not a promise of compatibility; no suffix is bumped
before Go-Live.

From Go-Live the retained rules apply as written: Source Adapter Versions
and Request Capacity are immutable and advance by registering a new
version (ADR 0004's one-predecessor window), export schema majors are
separately named and earlier majors stay readable (ADRs 0001 to 0003), and
the baseline is never edited (ADR 0006). The glossary marks the affected
definitions with "from Go-Live".

## Considered options

- **Keep versioning now so Go-Live needs no change.** Rejected: the cost is
  paid on every change before anyone benefits, and the retained material
  obscures the live definition.
- **Renumber every identifier to `@1` now.** Rejected: churn across seed
  rows, fixtures, and retained-bytes tests for no functional gain. Numbers
  are frozen instead; renumbering can be reconsidered at Go-Live.

## Consequences

ADRs 0001 to 0004 and the "baseline must not be edited" rule of ADR 0006
apply from Go-Live and are marked so. Before Go-Live: #124 edits the export
schema in place and deletes the earlier majors; #135 removes the retired
and predecessor Source Adapter Versions, the retirement runbook, and the
retired-runs query, leaving one registration per lineage; #134
raises One Piece's Request Capacity in place. Catalogue Revision retention
(current plus two predecessors for backup and recovery) is operational
safety, not definition versioning, and is unchanged. #136 lists the Go-Live
freeze steps.
