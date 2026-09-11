# Catalogue Export serialization profile

Profile: `card-keepr-ndjson-gzip@1`

One Catalogue Revision and export-schema major produces one manifest and one
component for every component declared by that schema version. Empty components
are present with zero records. A successful no-change Ingestion Run produces no
export.

Exports use manifest schema major 5 with the
`card-keepr-catalogue-export-manifest@5` format and canonical
`https://card-keepr.invalid/schemas/catalogue-export-manifest@5` manifest
schema URI. Every component advertises its canonical
`https://card-keepr.invalid/schemas/catalogue-export-record@5` URI with its
exact record `$defs` fragment. Consumers receive accepted card facts and explicit
unknowns, including Printed and Effective Rules Text, images, Products, Releases,
Distribution Contexts, Errata and identity/lifecycle relationships. Supporting
provenance, source health, admission decisions and tournament eligibility are
administrative or out of scope and are absent from these packages (ADRs 0013–0014).
The pre-Go-Live schemas are edited in place; older artifacts must be regenerated.
Consumer manifest, listing and component reads reject superseded evidence-bearing
manifests with `503 catalogue_export_unavailable`, including conditional and HEAD
requests. Their retained objects and guarded deletion remain intact. For an
existing pre-Go-Live database, use the supported fresh-baseline handoff and replay
retained evidence through reconciliation, inspection, approval and publication to
produce the current package; do not overwrite immutable exports or bypass backup
and deletion guards. This change performs no database cutover or release.

## Host independence

A Catalogue Export is an immutable, digest-verified package for offline use,
so nothing in it records the host or mount the API happens to be served from.
The manifest and its records reference API resources by stable identifier and
never by link: a manifest component is addressed by its `name`, and a
printing-image record by its `id`. The validator rejects a manifest or record
that embeds an API link, absolute or root-relative, before schema verification.

A consumer that wants the live bytes behind an identifier applies these route
templates to its own configured API base (`PUBLIC_BASE_URL`, which carries
the mount path, for example `https://card.keepr.digital/api`):

| Identifier                 | Route template                                                        |
| -------------------------- | --------------------------------------------------------------------- |
| Manifest component `name`  | `{PUBLIC_BASE_URL}/v1/catalogue-exports/{revision}/components/{name}` |
| Printing-image record `id` | `{PUBLIC_BASE_URL}/v1/printing-images/{id}/content`                   |

`{revision}` is the manifest's `catalogue_revision.id`. Moving the API to
another host or mount changes the consumer's base URL and nothing in any
retained package; `manifest_sha256` and every component digest keep verifying.

## Records and component order

Each component contains exactly one JSON object per line, validated against the
`record_schema` URI recorded in its manifest entry.

The component order is:

1. `supported-games`
2. `game-profiles`
3. `cards`
4. `printings`
5. `printing-images`
6. `products`
7. `releases`
8. `distribution-contexts`
9. `errata`
10. `relationships`

## Export schema compatibility

Before Go-Live exactly one export schema major exists (ADR 0008): changes edit
the major-5 schema in place, no earlier major is kept readable or checked in,
and exports produced under an earlier shape are regenerated rather than
migrated. Publishers emit `card-keepr-catalogue-export-manifest@5` and
`catalogue-export-record@5` component schema URIs, and the validator accepts
only that major. Consumers must select a decoder by `export_schema_major` and
URI and must never validate a component with a different major. From Go-Live,
export schema majors become immutable compatibility contracts and earlier
majors stay readable (ADRs 0001 to 0003).

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
- raw DEFLATE produced by the lockfile-pinned `pako@3.0.1` export compressor
  with level `9`, window bits `15`, memory level `8`, and fixed-Huffman
  strategy;
- CRC32 and ISIZE derived from the canonical NDJSON.

The production implementation must pin one compressor version and must retain
golden byte fixtures covering ASCII, non-ASCII NFC, nulls, empty components, and
more than one DEFLATE block. A compressor upgrade is accepted only if every
golden byte remains identical; otherwise it requires a new serialization
profile and export-schema major.
The authenticated export-boundary goldens are checked in at
`acceptance/fixtures/catalogue-export-gzip-golden.json`.

`compressed_sha256` and `compressed_bytes` in the manifest cover the complete
gzip member. An immutable R2 component key is derived from
`compressed_sha256`; retries may only confirm or reuse identical bytes.

## Manifest

Manifests validate against `schemas/catalogue-export-manifest-v5.schema.json`
and records against `schemas/catalogue-export-record-v5.schema.json`. Consumers
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
