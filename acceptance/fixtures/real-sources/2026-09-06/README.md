# Retained real-source evidence — 6 September 2026

Implements [#219](https://github.com/KeeprDigital/card-keepr/issues/219), under [#216](https://github.com/KeeprDigital/card-keepr/issues/216). This pack contains actual HTTP response bodies and original source image bytes. It changes no production adapters, admission policy, enabled games or release gates.

Run from the repository root, after `pnpm install --frozen-lockfile`:

```sh
node scripts/source-evidence/replay.mjs acceptance/fixtures/real-sources/2026-09-06
node --test acceptance/real-source-evidence.test.mjs
```

Replay reads local files only and emits JSON. It checks body/header SHA-256 digests, byte lengths, successful response metadata, capture intervals, complete record census, selected image URL associations and expected source facts. A missing or corrupt required asset fails with exit 1. Exit 0 establishes a sound replay pack, **not** full-game coverage, production adapter correctness, physical authentication or Go-Live readiness. The visual findings are retained review conclusions, explicitly distinguished from automated checks.

Open [comparison.html](comparison.html) locally for all seven official P-001 images paired with supplemental counterparts, the eighth supplemental image alongside official event corroboration, and representative Riftbound fronts. It needs no server or network; no image is cropped or re-encoded. Every caption names the capture and digest. The complete source URL, GET request headers, final URL, status, UTC start/end timestamps, response headers, entity-body byte length and digests are in [manifest.json](manifest.json). Raw bodies retain source boilerplate, prices and eligibility text incidentally; these are not selected Catalogue Data.

## Explicit English source coverage

| Source scope | Complete retained inputs | Exclusions and limits |
| --- | --- | --- |
| Bandai English P-001 search, NA/EU/OC/LATAM/ME site | One HTML response; all seven modal records `P-001`, `_p1`, `_p2`, `_p3`, `_p4`, `_p5`, `_p6`; all seven referenced front images | Only this exact search response. No other card numbers, regional sites, Product/event inventory or all-official-publication absence claim. The HTML reports seven results and presents all seven modals without another results page. |
| Limitless English P-001 | Base page and all seven linked `v=1`…`v=7` pages; all eight selected front images | No full-game catalogue, prices, decks or independent lineage claim. Variant suffixes are local source IDs. |
| Riot English Riftbound gallery | Entire 3,382,721-byte HTML response, including all 1,189 unique `cards.items` records: OGN 352, OGS 24, SFD 288, UNL 288, VEN 237 | This is the captured gallery census, not every issued Printing. Only six representative gallery image responses are retained; all other image URLs remain in the raw JSON as census inputs, not downloaded images. The preview article explicitly delays overnumbered gallery entries until real-world discovery. |
| Corroboration | Bandai Store Championship Wave 1 page and Trophy Card image; Riot Origins errata, preview explanation, Products and Sets into 2027 articles | Individually captured pages, not complete event/correction/product coverage. Bandai event evidence is outside the seven-record catalogue absence scope. |

Response/record/image counts are observed capture census values. They are not measured ingestion throughput, full-game capacity, retained production storage, or provider completeness guarantees. Replay also reports total retained body/header bytes. Capture timestamps describe these requests; origin `Date`, `Last-Modified`, `ETag` and cache headers remain independent evidence. The manifest documents that Python serialized response headers with LF; these are all received header fields, not exact HTTP wire framing. Body bytes are unchanged after transfer framing removal, requested with `Accept-Encoding: identity`. The pack’s `.gitattributes` disables Git newline conversion for raw assets, preserving their digests across checkouts.

## Verified bounded Printing examples

**Same Printing:** Bandai `P-001` and Limitless base depict the same punching Luffy artwork/crop, white frame, red panel, cost 6, power 7000, card text and P-001/P/block-1 markings. Both pages identify Promotion Pack 2022. Source watermarking and PNG/WebP compression are not Printing differences; physical finish remains unestablished.

**Genuine supplemental-only Printing within the declared official catalogue scope:** Limitless `v=4` depicts Luffy lifting his hat in a harbour, full-art blue top corners, a gold name and championship WINNER stamp. Direct inspection of all seven official catalogue images shows none has this artwork/stamp combination. This is not a counts or distribution-label deduction. Bandai's retained Store Championship Wave 1 page dates the event July 7–August 11, 2023 and links the visually matching Trophy Card image, corroborating a real issued appearance. Thus the Printing is absent from the bounded official catalogue search while demonstrably present in a separate official publication.

The other inspected mappings are `_p1`→`v=1`, `_p2`→`v=2`, `_p3`→`v=3`, `_p4`→`v=5`, `_p5`→`v=6`, `_p6`→`v=7`. In particular `_p1` and `_p2` share “Super Pre-Release” text but differ in artwork treatment and WINNER stamp. The base and `_p6` share artwork but have different framing/full-art treatment. These are evidence review findings, not installed production identity mappings.

## Riftbound source facts and unknowns

[expected-facts.json](expected-facts.json) supplies literal representative record IDs, public codes, collector numbers and orientations, plus replay assertions against the three retained publisher articles. All gallery records remain in the original `__NEXT_DATA__` payload; record-array position is not treated as identity. `OGN-001/298`, `OGN-066a/298`, and `SFD-227*/221` challenge denominator, alternate-art suffix and signature/overnumber conventions. `UNL-205/219` is a landscape battlefield; landscape does not establish a second face.

The visually inspected Kinkou Monk image `ogn-141-298` still says “buff two other friendly units,” while its captured gallery ability says “buff up to two other friendly units.” The retained publisher Erratum independently labels old/new text and identifies English-only changes for other cards. This is actual retained Printed/Effective Rules Text evidence, not an injected conflict. Preserve the image and correction separately; no scheduled activation is inferred.

The Products article announces five double-sided Secret Garden tokens and distinguishes an English Akali from a Chinese Kennen promotion; December 4, 2026 is an announced future release at capture time. Prose does not establish individual reverse faces or complete issued treatment inventory. The prior dossier's supplemental `Buff XXX` placeholder is not a verified official number and is not invented into this pack. No reverse-face or physical foil inference is made from missing fields or front images.

## Gate status and synthetic scenarios

Both required P-001 Printing gates pass **within the declared scope**. Complete bounded English response coverage and representative Riftbound correction/treatment evidence are retained. Full-game/all-issued-Printing coverage and complete image/face coverage remain **not established**. No real supplemental-only rules-level Card was found; that finding is optional under #216 and is explicitly not claimed.

[synthetic-admission.json](synthetic-admission.json) contains clearly labelled supplemental-only Card, missing-number, later-confirmation and conflict scenarios with expected policy outcomes for future admission tests. They are not evidence of real cards and must not be published as Catalogue Data. Acceptance tests inject omitted response, image-bit corruption and changed headers only into temporary copies; those failures are never recorded as observed source outages. This slice does not claim the later admission, API/export, consumer journey or recovery implementations pass.

## Optional future capture

```sh
python3 scripts/source-evidence/capture.py \
  acceptance/fixtures/real-sources/2026-09-06/manifest.json \
  /tmp/keepr-new-source-capture
```

This explicitly networked tool repeats the finite manifest URL inventory into a new directory and refuses overwrite. It retains successful responses incrementally but writes only an **unreviewed capture inventory**. It does not copy this pack's successful gates or expected facts: new response shapes, coverage, images and timestamps require a new review. Deterministic replay never invokes it. Keep existing retained captures immutable and retain source/rightsholder attribution; capture is not an assertion of ownership or permission for public redistribution.
