# Scryfall Magic pilot evidence

This pack retains real independent-source responses for [#326](https://github.com/KeeprDigital/card-keepr/issues/326).
It proves a representative English paper selection, not the complete Magic launch
inventory. Scryfall is the operator of the Source; Wizards of the Coast is Magic's
Publisher. Scryfall is the sole selected launch Source. Its API, bulk files and
image CDN are delivery surfaces of the same Source, not independent corroboration.
The depicted Publisher cards and artists remain attributable in the original images.

## Acquisition and integrity

`manifest.json` records exact acquisition URLs, resolved URLs, request headers,
response status, capture time, body lengths and SHA-256 digests. Every body in
`raw/` is unchanged. JSON and documentation were captured on 14 September 2026
by the initial source assessment. The saved header files serialize its retained
header name/value pairs with LF delimiters; they are not original HTTP wire bytes.
The original acquisition timestamps are retained as supplied, not invented start/end
intervals. Six JPEGs were subsequently fetched from exactly the returned normal
whole-card face URLs, with identifying User-Agent, `Accept: image/jpeg`, identity
encoding, no redirects and a 2 MiB cap. Image captures include start and completion
metadata in the manifest. Total retained image body size is 408,987 bytes.

The offline journey verifies every manifest body and header digest. For Card
responses originally acquired through set/collector or named aliases, it replays
the exact original body at the stable `uri` returned by that body. This is a
repeatable transport fixture, not a claim of a new live UUID capture. No fabricated
Card fields or image bytes appear in the real-source journey.

| Selected record | Scryfall record UUID | Categories and physical scope |
| --- | --- | --- |
| Delver of Secrets / Insectile Aberration, INR 60 | `6904ea20-e504-47da-95a0-08739fdde260` | Gameplay; transform front/back; nonfoil and foil |
| Chillerpillar art card, AMH1 1 | `8de2ff37-fdb7-4f77-9d48-e99afac9a79e` | Art; front and printed reverse; nonfoil |
| Chillerpillar, MH1 43 | `7f57005c-414d-4c83-9b4f-cd26e547d54d` | Gameplay; front; nonfoil and foil |
| Shapeshifter, TMH1 1 | `a33fda72-e61d-478f-bc33-ff1a23b5f45b` | Token; front; nonfoil and foil |

All four responses explicitly say `lang: en`, `digital: false`, and include paper
in `games`. Their release dates predate the pinned pilot cutoff. This establishes
English physical availability; it does not establish US, Asia or Oceania Release
availability. The Source Lineage is `scryfall-magic-en`, locale `en`, release region
`unknown`. Consumer Supported Game locale `EN` expresses the evidenced language.
No Product or regional Release is inferred from a set code.

## Qualified mapping

`magic@1` represents four Cards and seven finish-specific Printings. Scryfall
`oracle_id` is private source-scoped Card design evidence. Scryfall `id` locates
an upstream printed record; that record plus its declared finish distinguishes
Printing evidence. Canonical Card and Printing IDs remain persistent allocations.
`official_identity` stays unknown; community UUIDs are not Publisher identifiers.
The exact parser qualification permits a repeated design key to associate Cards
within this lineage, while equal names/facts cannot merge different qualified
keys. A changed admitted design key requires explicit identity review.

The transform faces remain ordered front/back facts. Parent UUID, face role,
optional face ID, optional face Oracle ID and illustration ID remain in the
private sidecar and original Snapshot. Absent face IDs are null; face position
is not fabricated as a source UUID. Set/collector values, finish, face names,
artists and original printed text are Printing facts. Current Oracle wording and
applicable gameplay fields are Card facts. Art has explicit inapplicable gameplay
and empty gameplay attributes, with its collectible fields on the Printing.

The Chillerpillar art front and gameplay front share illustration UUID
`6212644b-1700-4f2d-bbe3-d51bc45875e6`. Their Cards remain distinct. The relationship
names only the two selected nonfoil Printings whose retained observations prove
that association; it does not extend to all sibling Printings or claim a shared
reverse. Token `all_parts` and marketplace links do not imply additional admitted
Cards or discovery scope.

Scryfall is initially designated for card facts, Printing details and corrected
card content in this exact scope. Qualification, authority selection, physical
image evidence, entity admission and whole-candidate publication approval remain
separate gates. Supplementary-only or ambiguous evidence still requires owner
review. Designation is not Publisher confirmation.

## Access requirements and bounds

The retained documentation covers [API access](https://scryfall.com/docs/api),
[Card objects](https://scryfall.com/docs/api/cards),
[layouts](https://scryfall.com/docs/api/layouts),
[images](https://scryfall.com/docs/api/images),
[bulk data](https://scryfall.com/docs/api/bulk-data),
[rate limits](https://scryfall.com/docs/api/rate-limits) and
[Card manifests](https://scryfall.com/docs/api/cards/manifest).
The bodies in the manifest are the evidence for this dated qualification; access
requirements must be checked again before a fresh large acquisition.

API requests use HTTPS, an identifying User-Agent and an explicit Accept header;
no API key is needed. The retained API policy limits search, named, random and
collection endpoints to 2 requests/second, bulk metadata to 10/minute and other
endpoints to 10/second. The pilot uses four exact UUID endpoints and six separately
bounded images. Its registered request capacity is ten, snapshot cap 2 MiB, and
normal production host pacing applies. The test alone uses immediate pacing for
offline bytes. The adapter does not discover named/search pagination, arbitrary
links, prices, legalities or rulings. HTTP 429 applies a minimum 30-second cooldown and honors any longer Retry-After;
the retained policy describes a 30-second API ban. File surfaces have no
stated numerical limit but still require considerate bounded acquisition/cache.
Bulk downloads should be cached for at least 24 hours. Keep image copyright and
artist attribution intact; do not crop/re-encode scans or put a simple image proxy
behind a paywall. The pilot stores and serves the original whole-card JPEGs.

## Full import and factual gaps

A reproducible full import starts with a newly retained `/bulk-data` metadata
response and the exact `default_cards` item's `jsonl_download_uri`, `updated_at`,
content type and compressed size. Current retained metadata advertises gzipped
JSONL. Pin that response and download digest; stream decompression and line parsing
with independent compressed, decompressed, record and image budgets. Do not load
the complete archive into one Worker or perform one API request per Card. Filter
explicitly for English, paper, non-digital and evidenced issued status; default
cards alone does not guarantee English because foreign-only records may occur.
Deduplicate by record UUID, expand only supported evidenced finishes, preserve
Oracle/face evidence and unknowns, and report unsupported layouts/treatments and
missing imagery. Reconcile and review the complete declared scope before approval;
verify matching consumer export and an actual isolated SQL restore. This pilot's
four-UUID adapter is not that bulk importer; the larger work remains [#327](https://github.com/KeeprDigital/card-keepr/issues/327).

Known gaps remain explicit:

- No selected response supplies original `printed_text`. Printed Rules Text stays
  null; current Oracle wording is neither original wording nor a dated Publisher
  Erratum. No Errata are invented.
- Scryfall supplies a common scan set for nonfoil/foil. `finish_image` is null;
  the retained scans prove the depicted physical design, not the appearance of
  every finish. Normal/token backs are not captured; `card_back_id` alone is not
  image evidence. The art reverse and transform reverse are actually retained.
- Four records do not cover every layout, language, stamp, foil process, promo,
  regional issuance, historical wording or real-world collectible Card. Additional
  undocumented releases may exist. No overlap Source or independent corroboration
  was added, and this pilot makes no unique-promo coverage claim.

Run the offline lifecycle with `pnpm run test:acceptance scryfall-catalogue`.
Runtime-free adapter checks are in `test/domain/scryfall-source.spec.ts`; synthetic
migration/identity regressions are distinct from real-source evidence.

## Bulk regression records

The [bulk record selection](bulk/README.md) retains exact records from the pinned
Printing-bearing gzip JSONL source for #327. It extends parser coverage while the
complete import and its capacity/publication/restore evidence remain separate work.
