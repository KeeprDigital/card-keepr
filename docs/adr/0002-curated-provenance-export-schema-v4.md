# ADR 0002: Curated provenance requires export schema major 4

## Status

Accepted. The retention of earlier majors applies from Go-Live only (ADR 0008); before Go-Live the export schema is edited in place and earlier majors are deleted.

## Decision

Catalogue exports containing curated values or relationships use manifest and
record schema major 4. Major 4 adds discriminated curated targets and evidence,
requires closed relationship endpoints, and permits curated-only relationship
evidence without inventing Official Source lineage.

The checked-in major-3 record schema remains byte-identical. Existing retained
exports continue to be decoded with their recorded schema major and URI;
publishers and current consumers use major 4.

## Amendment: guarded owner deletion

Published export bytes are never rewritten. A deliberate owner deletion may
remove only a non-current export through the guarded, manifest-last deletion
workflow. It retains the Catalogue Revision and Curated Revision provenance,
the immutable deletion plan and confirmation result, manifest and object-set
digests, known component identities, operation history, tombstone, backups,
bookmarks, and recovery material. The current export remains protected, and
the current-plus-two D1/query repair window is unaffected by removal of an
older export package.

## Consequences

Curated provenance can be validated and replayed without accepting arbitrary
objects. Consumers must support major 4 before reading newly published exports,
while retained historical evidence remains verifiable against the original
major-3 schema bytes even if an authorized deletion has retired the package's
R2 objects.

## Amendment: consumer evidence boundary

[ADR 0013](0013-consumer-facts-and-complete-administrative-review.md) supersedes the requirement to expose supporting source or curated provenance in consumer exports. Evidence remains retained for administration and recovery; truthful catalogue facts and explicit unknowns remain in the consumer contract. This is a planning decision for the pre-Go-Live contract replacement, not an implemented schema change.
