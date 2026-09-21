# Piltover Archive bounded promo-lead evidence

This is the retained evidence for [#330](https://github.com/KeeprDigital/card-keepr/issues/330).
The selected Source is **Piltover Archive** at `piltoverarchive.com`, operated by
STGMNN Labs UG, with Source Lineage `piltover-archive-en` and adapter
`piltover-archive-en@1`. It is an independent Source using Riot assets, not an
Official Source; its English pilot has unknown release region. Riot remains the
designated authority for all three Riftbound areas. Registration permits bounded
reading only; it does not qualify every record or authorize a crawl.

## Retained bytes and acquisition

The owner cleared automated consumption on 2026-09-21 (issue comment); the
April 2026 terms text stays as recorded evidence in the earlier assessment. All
bytes here were acquired through the shipped ingestion Worker and owner CLI:
`source collect --budget-file` with `max_dispatches: 6`, `max_source_bytes:
8388608` and a 20-minute deadline, `source resume`, production host pacing at
2,000 ms per hostname, 30 s per document request and 60 s per image request,
1 MiB per body, no retries and no redirects. The Worker's default outbound
headers were used; the retained request headers are exactly those recorded.

[manifest.json](manifest.json) lists the three responses of the second run on
commit `4b32d21f` (run `run_b44202358fa01af8b2f159e9ae62c7b84f5996e9267e4039d393c784cf20096f`),
each with its exact URL, retained request/response headers, request, retrieval and
completion times, status, byte length and SHA-256, exported from the retained
snapshots through the snapshot content route and re-verified:

| Body                               | Request                                                                      | Bytes   |
| ---------------------------------- | ---------------------------------------------------------------------------- | ------- |
| `raw/gallery-page-1.html`          | `https://piltoverarchive.com/cards`                                          | 451,428 |
| `raw/arc-001-vi-destructive.webp`  | `https://piltoverarchive.b-cdn.net/temporary/1760416626325-f3zxpz5s8g7.webp` | 78,242  |
| `raw/ogn-001-blazing-scorcher.webp` | `https://cdn.piltoverarchive.com/cards/OGN-001.webp`                        | 82,946  |

All three returned HTTP 200 and total **612,616 bytes**; the Acquisition Budget
charged 3 dispatches and 612,616 bytes with nothing unsettled. The two art hosts
are distinct hostnames, so their requests were paced independently and completed
within one second of each other. A first run on the same commit at 06:39 UTC
(`run_1cacf801eab9723964a045c8a861e4ce0f151d29e4c08710583151dfa822388c`) retained
the gallery page only (451,428 bytes, SHA-256
`23ce3a3d6d8f6507fe9d640e53e1dd59d672743ec5f376d654c3549276e86a4c`) and failed with
`source_parse_failed`: the site had replaced the 14 September dialog render with a
structured `variants` list, and the parser was rewritten before the second run.
That first page is retained only in the ignored coordinator artifacts; four
dispatches were made in total. No other page, image, article, robots, terms,
Riftbound DB or HexDeck request was made.

## Actual pilot scope and qualification

The executable [pilot plan](../../../../docs/examples/piltover-archive-pilot-plan.json)
has one root, `/cards` (page 1 of 26, 48 rows, total display "1,240"), under the
`promo-lead-pilot` coverage. The adapter reads the Next.js flight payload's
`variants` records and pagination component; the rendered "1,240 cards" total
comes from the page markup. Request Capacity is **3**: the page plus the front art
of the two pinned rows. Every other row (including ARC-002 to ARC-006, OGN-007a/b,
OGN-027a and OGN-030a) is retained bytes only and produces no observation;
successful completion means this page and these fronts were captured, not that
the gallery, ARC or OGN is complete. Marketplace identifiers and prices are
retained in the raw record and never mapped.

| Record                                      | Retained front                                                                 | Admission and unknowns                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Blazing Scorcher `15eb5d43-…`, OGN-001      | English card: "OGN · 001/298", Unit/Noxus/Dragon, 5/5, Accelerate, Envar Studio | Qualified match to retained Riot `ogn-001-298` / `OGN-001/298` by number, set, name, type, rarity, domain, tags, energy, Might and wording. Owner link required (supplementary lineage). Piltover's `Power 0`/`mightBonus 0` map to Riot's absent fields; `foilMode: both` is retained, not a catalogued finish. |
| Vi, Destructive `a60d2063-…`, ARC-001       | **Chinese-language** print marked "ARC-001/006", Fortiche Production, ©2024     | Unresolved supplementary lead with `printing_locale_unresolved`, `printing_treatment_unresolved` and `physical_issuance_unresolved`. The English gallery text matches Riot's Vi, Destructive; no ARC prefix exists in the retained 1,189 Riot records; no English Printing is evidenced. |

Piltover keys ARC-001 and OGN-036 to one internal card identifier
(`4a10b30f-…`), a real same-Card/different-variant seam that the shared profile
represents through Riot's existing Vi, Destructive Card. Piltover's `[ACCELERATE]`,
`[1] [Fury]` and `[GANKING]`/`[Might]` tokens render the same publisher wording Riot
serves as `[Accelerate]`, `:rb_energy_1::rb_rune_fury:` and `:rb_might:`; the mapped
overlap repeats Riot's wording for that one pinned record and retains Piltover's
rendering in the sidecar. The pin compares every mapped field of the retained
record and fails closed on any change; dates, prices and Piltover's internal
identifiers are retained but not compared. There is no general transformation
from Piltover numbers to Riot public codes.

The Piltover WebP fronts are separate assets from Riot's PNGs (1030×1438 and
514×720 versus 744×1039); equal bytes were never assumed. Linking adds the
Blazing Scorcher WebP as a second retained front of the existing Printing; the
ARC-001 WebP stays private source-record evidence of an unresolved proposal.

## Repeatable native journey

`pnpm run test:acceptance piltover-archive-catalogue` replays the unchanged page
and both fronts through production collection, reconciliation, a rejected
structure-less admission of the ARC-001 lead, the owner link of the overlap,
whole-candidate approval, published API reads with both retained fronts served
byte-for-byte, matching export and actual isolated SQL import/restore. It starts
with a Blazing Scorcher Riot predecessor and a real publication/backup
checkpoint; only that predecessor's pagination envelope is synthetic around the
unchanged Riot record from `2026-09-08-riftbound/raw/cards-0.json` and the
unchanged publisher image from `2026-09-06/raw/riftbound-image-ogn-001-298.png`.
The accepted catalogue gains a second front, **no new Card or Printing**. Tests
and source selection do not install production decisions.

## Intended full-import scope, not executed

The gallery exposes 26 pages of 48 rows (`?page=N`) with set, type, rarity and
variant controls, and each row carries `variantNumber`, `variantType`,
`variantTypes`, `variantLabel`, `foilMode`, `parentVariantId`, `releaseDate`, the
set record and full English card facts. A reproducible census would freeze every
page in one dated pass, compare row identifiers and counts across pages, retain
duplicates and contradictions with both provenances, compare each `variantNumber`
against the retained Riot inventory, and inventory the original news reporting
(the Miss Fortune prize and Nexus Night articles) separately from gallery rows.
Language must be established per retained front, as the ARC-001 case shows;
`foilMode`, `variantType` and `rarity: Showcase` remain source labels until a
qualified physical observation exists. Those are proposed steps, not measured
counts or an installed capability; this pilot establishes neither launch coverage
nor Go-Live readiness.
