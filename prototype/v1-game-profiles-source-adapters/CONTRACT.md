# Proposed v1 Game Profiles and source-adapter contracts

Contract family: `card-keepr-game-contracts@1`

This is the proposed answer to the Wayfinder decision
“Define the v1 Game Profiles and source-adapter contracts.” It fixes the
implementation-visible semantics that an adapter may not invent.

All raw Official Source labels and values are retained on immutable Source
Observations. Catalogue Data contains only normalized fields admitted by the
selected versioned Game Profile. A field described as nullable is present with
`null` when no canonical value is supported; omission is reserved for response
projection, not stored meaning.

## Shared contract boundary

The shared core, rather than a Game Profile, owns:

- opaque Card and Printing identity;
- `official_identity`, Card name, and Effective Rules Text;
- Printing rarity as `{ normalized, raw }`;
- nullable Printed Rules Text;
- Printing Images and their roles;
- Products, Releases, Distribution Contexts, Errata, and Legality Rules;
- lifecycle, provenance, evidence category, and unresolved disagreement.

A Game Profile owns only rules-relevant game-specific Card attributes and the
small number of game-specific Printing attributes described below. Source
locators, query categories, HTML labels, Product paths, source buckets, and raw
unknown fields never enter a Game Profile.

Each canonical Card has:

```json
{
  "game_data": {
    "profile": "<game>@1",
    "attributes": {}
  }
}
```

Each canonical Printing may have:

```json
{
  "game_data": {
    "profile": "<game>@1",
    "attributes": {}
  }
}
```

Profile objects reject additional properties. Adding a newly modelled mechanic
is additive only when old consumers can ignore it without changing existing
meaning; otherwise it requires a new profile major version. Unknown source
fields stay on Source Observations until a profile decision admits them.

## Common normalization

- HTML formatting is retained in the Source Observation. Canonical text is a
  lossless plain-text rendering with source line/section boundaries preserved.
- Source `-`, blank, and explicitly unavailable values normalize to `null`, not
  zero or an empty label. The raw token remains on its Source Observation.
- Numeric display strings normalize to non-negative integers only when the
  entire semantic value is numeric. Unparseable required values hard-fail.
- Multi-valued fields are ordered by the profile’s declared semantic order when
  one exists; otherwise their normalized values are sorted and deduplicated.
- Colour values use lower-case canonical keys. The v1 shared vocabulary is
  `red`, `green`, `blue`, `purple`, `black`, `yellow`, `white`, and
  `colourless`. A new raw colour is preserved and raises a schema-review
  warning; it is not guessed into an existing colour.
- Controlled values are compared after Unicode normalization, whitespace
  collapse, and case-insensitive matching against an adapter-owned mapping.
  The exact raw value remains available.
- Rarity belongs to Printing. Its normalized value is game-scoped and its raw
  value is mandatory when the Official Source publishes one. A missing rarity
  is `null`; conflicting rarity is a reconciliation warning unless it makes a
  proposed Printing merge materially incompatible.

## `one-piece@1`

### Card attributes

| Field | Type | Requiredness and meaning |
| --- | --- | --- |
| `card_type` | `leader \| character \| event \| stage \| don` | Required. `don` is only the generic DON!! Card. |
| `colours` | unique colour array | Required; empty only for the generic DON!! Card. |
| `cost` | non-negative integer or `null` | Required and non-null for Character, Event, and Stage; null for Leader and DON!!. |
| `life` | non-negative integer or `null` | Required and non-null for Leader; null otherwise. |
| `battle_attributes` | unique string array | Required; normalized Official Source Attribute values. |
| `power` | non-negative integer or `null` | Required key; null when inapplicable or not published. |
| `counter` | non-negative integer or `null` | Required key; null when inapplicable or not published. |
| `traits` | unique string array | Required; normalized Official Source Type values. |
| `block_icons` | unique string array | Required; current block labels without inventing numeric meaning. |
| `effect_text` | string or `null` | Card List Effect after lossless text normalization. |
| `trigger_text` | string or `null` | Card List Trigger after lossless text normalization. |

### Printing attributes

`illustration_types` is an optional unique array of `comic`, `animation`,
`original`, or `other`. It is present only when derived from explicit Official
Source illustration-filter membership. A source suffix is not enough to infer
it.

### DON!! exception

The generic DON!! Card uses
`{"kind":"functional_designation","value":"DON!!"}` and `card_type: "don"`.
Officially distinguished DON!! artworks or treatments may be catalogued as
Printings when the ordinary exact identity evidence is present. Version 1
coverage of those Printings and Printing Images is explicitly
non-comprehensive: absence never proves that the DON!! Card has zero
Printings. Product membership by itself remains Source Observation evidence
and does not create a Printing.

## `fusion-world@1`

### Card attributes

| Field | Type | Requiredness and meaning |
| --- | --- | --- |
| `card_type` | `leader \| battle \| extra \| energy_marker` | Required. |
| `colours` | unique colour array | Required. Official `-` becomes `colourless`. |
| `cost` | non-negative integer or `null` | Required key; null when inapplicable. |
| `specified_cost` | array of `{ colour, count }` | Required; empty when not published. |
| `power` | non-negative integer or `null` | Required key. |
| `combo_power` | non-negative integer or `null` | Required key. |
| `traits` | unique string array | Required; Special Traits. |
| `skills` | array of `{ kind, text }` | Required. Kind is `ordinary`, `front`, or `back`. |
| `leader_faces` | exactly two face objects | Required only for Leader; roles must be one `front` and one `back`. |

A Leader face contains role, name, nullable power, traits, and skills. Its
Printing must have front and back Printing Images. Ordinary cards have one
front Printing Image unless the source explicitly publishes another role.

The Printing profile has no v1 game-specific fields. Variant suffix and
“Where to get it” are source-locator and Distribution Context evidence,
respectively.

## `digimon@1`

### Card attributes

| Field | Type | Requiredness and meaning |
| --- | --- | --- |
| `card_type` | `digi_egg \| digimon \| tamer \| option \| digimon_option` | Required. |
| `colours` | unique colour array | Required. |
| `level` | non-negative integer or `null` | Required key. |
| `play_cost` | non-negative integer or `null` | Required key. |
| `use_cost` | non-negative integer or `null` | Required key. |
| `dp` | non-negative integer or `null` | Required key. |
| `form` | string or `null` | Required key. |
| `attribute` | string or `null` | Required key. |
| `traits` | unique string array | Required. |
| `digivolution_requirements` | requirement array | Required; empty when none are published. |
| `text_sections` | typed text-section array | Required; preserves section boundaries. |
| `dual_colours` | unique colour array | Optional current mechanic. |
| `dual_cost` | non-negative integer or `null` | Optional current mechanic. |
| `link_dp` | non-negative integer or `null` | Optional current mechanic. |

A digivolution requirement contains optional source ordinal, nullable
from-level, colours, non-negative cost, and nullable raw condition text.

Known text-section kinds are `effect`, `inherited_effect`, `security_effect`,
`rule`, `special_digivolution_condition`, `dual_effect`, `dual_rule`,
`link_condition`, and `link_effect`. The section text remains the authoritative
normalized representation; v1 does not parse a semantic rules AST.

The Printing profile requires `alternative_art: boolean`. It does not infer
finish, treatment, or illustrator from Product marketing.

The unsuffixed/base record is authoritative for the Card display name when it
exists. Rules-relevant disagreements across Printings require unanimous
normalized values or an explicit Erratum/authority rule; otherwise publication
is blocked. The English source’s statement that Japanese data has priority is
retained as an authority caveat, but Japanese ingestion remains out of scope.

## `gundam@1`

### Card attributes

| Field | Type | Requiredness and meaning |
| --- | --- | --- |
| `card_type` | `unit \| pilot \| command \| base \| resource \| ex_base \| ex_resource \| unit_token` | Required. |
| `colours` | unique colour array | Required; Official Source `-` is `colourless` only where it semantically means no colour. |
| `level` | non-negative integer or `null` | Required key. |
| `cost` | non-negative integer or `null` | Required key. |
| `block_icon` | string or `null` | Required key; no numeric interpretation is invented. |
| `effect_text` | string or `null` | Required key. |
| `zone` | string or `null` | Required key. |
| `traits` | unique string array | Required. |
| `link_condition` | string or `null` | Required key. |
| `ap` | non-negative integer or `null` | Required key. |
| `hp` | non-negative integer or `null` | Required key. |
| `series_titles` | unique string array | Required; normalized values from the Official Source Title field. |

The Printing profile requires `alternate_art: boolean`. A rarity decoration
such as `+` is retained raw and normalized by the Gundam rarity mapping; it is
not automatically treated as a finish.

`EN-ASIA` and `EN-US` are separate source lineages. Shared Card/Printing facts
may be one canonical entity, but Releases and Legality Rules always retain their
locale. The API must not synthesize an Oceania Legality Status.

## Printing identity and re-identification

Every Printing has an opaque Card Keepr identity. An observed Bandai locator is
never that identity.

A known locator reconnects only while Card and material facts remain
compatible. A new locator reconnects automatically only when exactly one
existing Printing has all of:

1. the same Card;
2. the same source family/lineage;
3. the same normalized artwork fingerprint;
4. the same digest of printed rules-relevant fields;
5. compatible normalized rarity; and
6. compatible explicit treatment, including both being unknown.

The content SHA-256 of an image is retained but is not the artwork fingerprint:
re-encoding or resolution changes must not create a new Printing. One exact
match reconnects and retains both locators as evidence. More than one match,
material contradiction, or an insufficiently evidenced zero-match blocks
publication. A zero-match creates a new Printing only when the source record is
internally complete and its appearance is demonstrably novel.

Gundam cross-locale merging uses the same exact material identity fields:
Card, source family/lineage, normalized artwork fingerprint, printed
rules-relevant fields, normalized rarity, and explicit treatment. Variant
key/suffix and Product, set, source-bucket, Release, and Legality memberships
are corroborating provenance only and never identity gates. A substantive
conflict in the exact material fields blocks publication. Observation on only
one English surface is publishable with a warning.

Distribution through an additional Product, source bucket, event, or promotion
never creates a Printing by itself.

## Adapter lifecycle shared by every Official Source

Each adapter version declares one immutable source lineage and exactly one Game
Profile version.

1. Discover live source vocabulary and preserve its snapshot.
2. Produce deterministic, disjoint leaf partitions using the adapter’s declared
   split order.
3. Fetch every required listing, detail, Product, legality, and Errata surface.
4. Persist exact bytes and provenance before parsing.
5. Parse with the pinned adapter version into immutable Source Observations.
6. Prove the structural completeness invariants below.
7. Reconcile by explicit authority and identity rules.
8. Emit a deterministic candidate, diagnostics, counts, and content digest.

Every raw field mapping names its canonical target or explicitly targets only a
Source Observation/relationship candidate. Unrecognized optional labels are
never discarded.

## Adapter contracts

### `one-piece-en@1`

- Locale authority: the English `NA/EU/OC/LATAM/ME` surface.
- Card identity: `(one-piece, card_number)`; the DON!! exception is separate.
- Printing locator: `(one-piece-en, source_record_id)`.
- Discovery: discover every numeric Recording from the current Card List and
  fetch each Recording exactly once. Client-side pagination is ignored because
  every row is already in the HTML.
- Required surfaces: Card List, Products index and included card-bearing detail
  pages, current and historical restrictions, block policy/updates, release
  timing and language policy, Errata, and the DON!! rules source.
- Required row fields: source record id, Card Number, name, Category, Color, and
  image URL. Rarity is nullable but preserved when present.
- Authority: Card List for broad Card facts; official Errata over Card List for
  Effective Rules Text; Product detail over Card Set(s) text for Releases;
  dated rules/restriction sources for Legality Rules.
- Card Set(s), Recording membership, Notes, and Product links remain separate
  evidence. Repeated compatible source records aggregate onto one Printing.

### `fusion-world-en@2`

- Locale authority: `/fw/en/`, explicitly covering Oceania.
- Card identity: `(fusion-world, card_number)`.
- Printing locator: `(fusion-world-en, card_number, variant_suffix)`, where the
  suffix may be empty. An unsuffixed Printing is never synthesized.
- Discovery: snapshot live facets. Split first by Card Type, then Colour, then
  Cost as needed. A leaf still displaying “Too many search results” is a hard
  failure. All leaf partitions must be disjoint or deterministically
  deduplicated by the full locator.
- Required detail fields: requested Card Number, parsed Card Number, name, Card
  Type, Color, and all published image URLs. HTTP 200 with blank/mismatched Card
  Number is a hard failure.
- Required surfaces: all Card leaf partitions and details, every server-paged
  Product index page plus coming-soon entries and included details, current and
  historical legality sources, and Errata history.
- Authority: validated Card detail consensus; official Errata over current
  detail for Effective Rules Text; Product detail over category/distribution
  text for Release; rules hub/current list/history for Legality Rules.
- Leader detail must yield exactly one front and one back face and Printing
  Image. Energy Marker rarity may be null.

### `digimon-en@2`

- Locale authority: the official English site. Release region remains explicit
  or `unknown`; a US-oriented date is never relabelled Oceania.
- Card identity: `(digimon, card_number)`.
- Printing locator: `(digimon-en, popup_id)`.
- Discovery: snapshot every current Version/category. Split a category further
  by Card Type, then Colour if it carries the source’s greater-than-1,000 cap.
  Every discovered category must be covered by complete leaf partitions.
- Required row fields: popup id, Card Number, name, Card Type, and image URL.
  Rarity is nullable.
- Required surfaces: Card List categories, every Product tile with an explicit
  card-bearing/non-card/announced classification, restriction history/current
  list, and Errata.
- Authority: unsuffixed/base record for display name when present; unanimous
  validated source records for rules facts; official Errata over Card List;
  only explicit regional Product facts for Releases.
- Every known labelled mechanic maps through the profile. Unknown labels remain
  verbatim Source Observation fields and raise a warning.
- Notes and category memberships create at most explicit or deterministic
  relationship evidence; fuzzy matches never publish a Product relationship.

### `gundam-en-asia@2` and `gundam-en-us@2`

- Each locale is a separate source lineage with its own opaque package IDs.
- Card identity: `(gundam, card_number)`.
- Printing locator: `(source_lineage, detailSearch)`.
- Discovery: snapshot every live package option and fetch every complete result
  page, then deduplicate detailSearch keys before details.
- Required detail fields: detailSearch, matching Card Number, name, Type, and
  image URL. Official `-` values are valid raw values and normalize by field.
- Required surfaces per locale: Card packages/details, Product index/details,
  locale-specific legality, and Errata.
- `EN-ASIA` is preferred for shared facts and `EN-US` corroborates/fills gaps.
  A substantive shared-fact conflict is retained unresolved and hard-blocks
  publication; precedence does not erase it.
- Product Releases and Legality Rules remain separately `EN-ASIA` or `EN-US`.
  Different regional dates are expected, not conflicts.

## Structural completeness and diagnostics

Structural evidence, rather than an absolute catalogue-size expectation, decides
whether coverage is complete. Growth or removal can be legitimate; therefore a
count swing never hard-fails by itself.

### Hard failures

- any required area, discovered partition/page, required detail, or required
  rules stream is unavailable after bounded retries;
- a leaf partition still displays the source cap signal;
- rendered/source-declared result count differs from parsed record count;
- any discovered partition is omitted, overlaps incompatibly, or cannot be
  proven complete;
- required Card identity, Printing locator, Source Snapshot, provenance, or
  required Printing Image is missing;
- required field parsing fails or one natural identity maps to incompatible
  records;
- Printing re-identification is ambiguous or materially contradictory;
- a canonical conflict has no deterministic authority rule;
- new Erratum or Legality wording cannot be represented without invented
  precision; or
- required audit evidence or diagnostics cannot be persisted.

Any hard failure blocks the whole selected Ingestion Run scope before owner
approval.

### Warnings

- any new source facet, category, package, field label, or controlled raw value;
- an absolute count delta at least
  `max(25 records, ceil(20% × prior comparable count))`;
- a previously observed record no longer observed in a structurally complete
  run;
- an unknown optional field retained only on Source Observation;
- an unresolved noncanonical Product or Distribution Context relationship; or
- a Gundam Printing observed on only one English surface.

Warnings appear in the candidate diff and require ordinary owner review, but do
not independently make the candidate unpublishable.

## Scenarios that must remain representable

The executable prototype covers these contract boundaries:

1. one One Piece Printing repeated across multiple Recordings;
2. the generic DON!! Card with known Printings allowed but explicitly
   non-comprehensive Printing and Printing Image coverage;
3. a Fusion World Leader that exists only with a suffixed locator;
4. a broad-query cap that blocks publication;
5. a new Digimon mechanic retained raw as a warning;
6. a missing Digimon category that makes completeness unprovable;
7. one corroborated Gundam Printing with two locale records and distinct
   regional Release/Legality facts;
8. a substantive Gundam shared-fact conflict;
9. exact Printing re-identification after a source-locator change; and
10. ambiguous Printing re-identification that requires review.
