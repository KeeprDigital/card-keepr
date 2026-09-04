# ADR 0002: Curated provenance requires export schema major 4

## Status

Accepted. Export schema majors are separately named and earlier majors remain readable. The pre-Go-Live exception in ADR 0008 ends with the owner-approved #136 cutover.

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
