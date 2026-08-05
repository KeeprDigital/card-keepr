# ADR 0002: Curated provenance requires export schema major 4

## Status

Accepted

## Decision

Catalogue exports containing curated values or relationships use manifest and
record schema major 4. Major 4 adds discriminated curated targets and evidence,
requires closed relationship endpoints, and permits curated-only relationship
evidence without inventing Official Source lineage.

The checked-in major-3 record schema remains byte-identical. Existing exports
continue to be decoded with their recorded schema major and URI; publishers and
current consumers use major 4.

## Consequences

Curated provenance can be validated and replayed without accepting arbitrary
objects. Consumers must support major 4 before reading newly published exports,
while historical major-3 exports remain verifiable against their original
schema bytes.
