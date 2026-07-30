# Catalogue Export serialization profile

Profile: `card-keepr-ndjson-gzip@1`

One Catalogue Revision and export-schema major produces one manifest and one
component for every component declared by that schema version. Empty components
are present with zero records. A successful no-change Ingestion Run produces no
export.

New exports use manifest schema major 2. The `legality-rules` component uses
record schema major 2 so `LegalityRuleRecord` retains both the Official Source
identity and the exact normalized discriminated `effect` with every operand.
Components whose record contracts did not change continue to advertise record
schema major 1. Schema-major-1 manifests and components remain
revision-addressed, immutable, and readable; they are never rewritten during
the upgrade.

## Records and component order

Each component contains exactly one JSON object per line, validated against the
`record_schema` URI recorded in its manifest entry.

The v2 component order is:

1. `supported-games`
2. `game-profiles`
3. `cards`
4. `printings`
5. `printing-images`
6. `products`
7. `releases`
8. `distribution-contexts`
9. `errata`
10. `legality-rules`
11. `relationships`

## Export schema compatibility

Export schema major 2 is intentionally incompatible with major 1. Product,
Release, Distribution Context, and typed game-profile records added required
properties that a major-1 consumer, whose schemas reject unknown properties,
cannot safely interpret. Publishers therefore emit the
`card-keepr-catalogue-export-manifest@2` format and `catalogue-export-record@2`
component schema URIs. Consumers must select a decoder by
`export_schema_major` and URI; they must not validate a major-2 component with a
major-1 schema. A consumer migrating from major 1 must add the four new
component decoders and accept required nullable Release `status` values before
switching its current-manifest pointer.

Within a component, records are sorted by the UTF-8 byte order of their opaque
`id`; `game-profiles` instead sort by `profile`. IDs and profile names are
unique within their component. Relationship records sort by their own opaque
identity, not by endpoint.

## Canonical JSON and NDJSON

Every line uses this exact canonicalization:

- UTF-8 without a byte-order mark;
- object keys recursively sorted by UTF-8 byte order;
- arrays preserve schema-defined semantic order; arrays declared as sets are
  sorted and deduplicated before serialization;
- strings are Unicode NFC and escape only quotation mark, reverse solidus, and
  U+0000–U+001F using lower-case JSON escapes where a short escape exists and
  four lower-case hexadecimal digits otherwise;
- integers use base-10 with no leading zero or positive sign;
- timestamps are UTC RFC 3339 with exactly three fractional digits and `Z`;
- calendar dates use `YYYY-MM-DD`;
- every schema-required nullable key is present with `null`; optional additive
  keys are omitted when absent;
- non-finite numbers and floating-point catalogue values are forbidden; and
- each canonical object is followed by one LF (`0x0a`), including the last.

The component content digest is lower-case hex SHA-256 of the uncompressed
NDJSON bytes. `uncompressed_bytes` counts those exact bytes.

## Deterministic gzip

Each component is one gzip member over the canonical NDJSON, with:

- compression method DEFLATE;
- no optional filename, comment, extra, or header-CRC fields;
- MTIME `0`;
- XFL `2`;
- OS `255`;
- raw DEFLATE produced by the checked-in, lockfile-pinned export compressor with
  level `9`, window bits `15`, memory level `8`, and fixed-Huffman strategy;
- CRC32 and ISIZE derived from the canonical NDJSON.

The production implementation must pin one compressor version and must retain
golden byte fixtures covering ASCII, non-ASCII NFC, nulls, empty components, and
more than one DEFLATE block. A compressor upgrade is accepted only if every
golden byte remains identical; otherwise it requires a new serialization
profile and export-schema major.

`compressed_sha256` and `compressed_bytes` in the manifest cover the complete
gzip member. An immutable R2 component key is derived from
`compressed_sha256`; retries may only confirm or reuse identical bytes.

## Manifest

New manifests validate against
`schemas/catalogue-export-manifest-v2.schema.json`; historical v1 manifests
validate against `schemas/catalogue-export-manifest.schema.json`. Consumers
must resolve each component's advertised `record_schema` URI rather than infer
it from the manifest major. The `components` array follows the fixed component
order above. The manifest is canonical JSON under the same rules, followed by
one LF, and is not compressed.

`manifest_sha256` cannot hash a document containing itself. It is therefore the
SHA-256 of the canonical manifest with `manifest_sha256` set to 64 ASCII zeroes.
The published manifest contains the resulting lower-case digest. Verification
replaces the field with zeroes, canonicalizes, and hashes.

Publication verifies schemas, row counts, ordering, both component digests,
byte counts, the manifest digest, the Catalogue Revision content digest, and
the presence of every immutable R2 object before changing the current-revision
pointer.
