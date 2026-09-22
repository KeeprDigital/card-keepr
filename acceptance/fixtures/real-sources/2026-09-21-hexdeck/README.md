# HexDeck bounded set-slice and token evidence

This is the retained evidence for [#332](https://github.com/KeeprDigital/card-keepr/issues/332).
The selected Source is **HexDeck** at `www.hexdeck.io`, a fan project using Riot
assets, with Source Lineage `hexdeck-en` and adapter `hexdeck-en@1`. It is an
independent Source, not an Official Source; its English pilot has unknown release
region. Riot remains the designated authority for all three Riftbound areas.
Registration permits bounded reading only; it does not qualify every record or
authorize a crawl.

## Retained bytes and acquisition

The owner cleared automated consumption on 2026-09-21 (issue comment); the
June 2026 terms text stays as recorded evidence in the earlier assessment. All
bytes here were acquired through the shipped ingestion Worker and owner CLI
(`source collect --budget-file` with `max_dispatches: 6`, `max_source_bytes:
6291456` and a 15-minute deadline, `source resume`), production host pacing at
2,000 ms per hostname, 30 s per document and 60 s per image request, 1 MiB per
body, no retries and no redirects, with the Worker's default outbound headers.
Three runs on commit `4b32d21f` made **12 dispatches** in total:

| Run     | Ingestion Run                          | Requests                                                                 | Result                                                                                                   |
| ------- | -------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| stage-1 | `run_6d2c7629…` 07:02 UTC              | homepage, `/help`, search page 1, Blazing Scorcher base locator          | Three pages HTTP 200 (535,884 bytes); the bare `imagedelivery.net/…/` locator returned **HTTP 400**, a tolerated `source_image_rejected` gap |
| stage-2 | `run_0c15c46f…` 07:06 UTC              | search pages 1, 7, 8 and the page-referenced `standard` Blazing Scorcher front | Four HTTP 200 (964,371 bytes); pages 7 and 8 showed OGN ending in the T01 Buff token before SFD, no ARC rows |
| stage-3 | `run_8abb665e…` 07:08 UTC              | search pages 1 and 7 and both pinned `standard` fronts                   | Four HTTP 200 (736,891 bytes); the executable pilot                                                      |

[manifest.json](manifest.json) records every retained body with its exact URL,
run, request/response headers, request, retrieval and completion times, status,
byte length and SHA-256, exported from the retained snapshots through the snapshot
content route and re-verified. The stage-3 captures are the executable pilot;
the homepage, Advanced Search Guide and page 8 are retained documentation from
the earlier runs. Repeated pages were byte-identical across runs, and search page
1 is byte-identical to the older locally retained gallery body (SHA-256
`4c58afe0…`), which now has capture metadata. No other page, image, terms,
robots, Piltover Archive or Riftbound DB request was made.

| Body                                        | Request                                                                                 | Bytes   |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| `raw/search-set-page-1.html`                | `/cards?displayFormat=Images&page=1&sortDirection=Ascending&sortField=Set`              | 291,016 |
| `raw/search-set-page-7.html`                | `/cards?displayFormat=Images&page=7&sortDirection=Ascending&sortField=Set`              | 297,009 |
| `raw/ogn-001-blazing-scorcher-standard.webp` | `imagedelivery.net/hLYQStpAJ2Sj9NgyRRqPTQ/3c5370d6-…/standard`                         | 82,668  |
| `raw/ogn-t01-buff-standard.webp`            | `imagedelivery.net/hLYQStpAJ2Sj9NgyRRqPTQ/8d1fe662-…/standard`                         | 66,198  |
| `raw/homepage.html`, `raw/help.html`        | `/`, `/help` (stage-1 documentation)                                                    | 52,635 / 192,233 |
| `raw/search-set-page-8.html`                | `…&page=8…` (stage-2 census page, SFD rows only)                                        | 293,678 |

## Actual pilot scope and qualification

The executable [pilot plan](../../../../docs/examples/hexdeck-pilot-plan.json)
has two roots under the `set-slice-pilot` coverage: page 1 of the Images-format
search sorted by Set (24 OGS and 26 OGN rows of 940) and page 7 (OGN 285–298,
the OGN T01 Buff token, then SFD 001–035). The adapter reads the Next.js flight
payload's `results` list and pagination state; a listing's front is fetched only
at the `standard` delivery variant the page itself renders, never at the bare
JSON locator. Request Capacity is **4**: two pages and two pinned fronts. Every
other row is retained bytes only; successful completion means these pages and
fronts were captured, not that OGS, OGN, SFD or the 940-row inventory is complete.

The search form is client-rendered: no retained page exposes the HTTP parameter
that carries an advanced query, so the documented `c:`, `set=`, `t=` syntax could
not be used for a named promo query. Sorting by Set lists OGS, OGN, SFD…; the
ARC rows that Piltover Archive shows did not appear before SFD and were not
sought further. The listing surface carries no rules text, artist, finish,
locale, release date or upstream identifier.

| Listing                                      | Retained front                                                                          | Admission and unknowns                                                                                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blazing Scorcher `cmpmw79dv…`, OGN 001        | English card "OGN · 001/298", Unit/Noxus/Dragon, 5/5, Accelerate, Envar Studio          | Same displayed number, name, type, rarity, domain, energy and Might as retained Riot `ogn-001-298`; HexDeck's `power: 0` where Riot omits power. Without rules text or artist the listing cannot form the profile's Card, so it stays an unresolved review record (`card_facts_incomplete`) and cannot be linked. |
| Buff `cmpmw7kdx…`, OGN T01                    | English token "Buff", +1 Might, "A unit may have no more than one buff at a time.", OGN, League Splash Team, no collector number, no promo mark | Riot lists Buff as `UNL-T04` and Riftbound DB retains a PR promo Buff with a PROMO mark; HexDeck files an OGN-marked token as T01. Which physical object each represents remains unresolved; the token has no domain, type, energy or power. |

Both fronts are separate assets from Riot's PNGs (the Blazing Scorcher WebP
digest differs from both Riot's PNG and Piltover's WebP); equal bytes were never
assumed. They are private **source-record image evidence** of unresolved
proposals, not published Printing Images. Pins compare every mapped field of the
retained listing and fail closed on any change.

## Repeatable native journey

`pnpm run test:acceptance hexdeck-catalogue` replays the two unchanged pages and
both fronts through production collection, reconciliation, a rejected link of
the structure-less Blazing Scorcher record, whole-candidate approval with both
review records excluded by warning, published API reads, matching export and
actual isolated SQL import/restore. It starts with a Blazing Scorcher Riot
predecessor and a real publication/backup checkpoint; only that predecessor's
pagination envelope is synthetic around the unchanged Riot record from
`2026-09-08-riftbound/raw/cards-0.json` and the unchanged publisher image from
`2026-09-06/raw/riftbound-image-ogn-001-298.png`. The accepted catalogue is
unchanged: the consumer revision is preserved while the fresh evidence receives
its own verified backup. Tests and source selection do not install production
decisions.

## Access evidence behind the pacing bounds

The 14 September assessment retained `https://www.hexdeck.io/robots.txt` as an
HTTP 404 Vercel HTML page (36,280 bytes, SHA-256
`2a4a1781d62f2dda76b8c0a90e8d875539c13619352ab8cb42341018cb4a2d82`): there is no
robots policy. The retained terms (updated 23 June 2026) require written
permission for automated scripts; the owner cleared automated consumption on
2026-09-21. The search pages are Next.js renders on Vercel; fronts are served by
the shared Cloudflare Images host `imagedelivery.net`. The registration's #389
bounds are therefore conservative: the page host is sequential with a 1 s floor
and 8 s ceiling; the image host allows up to 4 in flight with a 100 ms floor and
2 s ceiling.

## Search census scope (offline-ready, not yet run live)

The `search-census` coverage ([plan](../../../../docs/examples/hexdeck-census-plan.json))
starts at `/cards?displayFormat=Images&page=1&sortField=Set&sortDirection=Ascending`,
the parameter order of HexDeck's own navigation link, which keeps its request
identities apart from the pilot pages. Page 1 discovers pages 2 to
`ceil(totalCount / pageSize)`; each page discovers the `standard` front its own
markup references for each listing. Every page must echo `Images`/`Set`/`Ascending`
and carry `pageSize` rows (the remainder on the last page); pages 2 to N are
parsed with the retained page 1 as parent context and must repeat its
`totalCount` and `pageSize`. Otherwise the parse fails closed. Retained pages 1,
7 and 8 parse unchanged as census pages. Every listing becomes a source-record
Entity Proposal with the pilot's three issues; the two pinned listings keep their
digest-pinned fronts while they fit, and a changed pin is retained with
`pinned_qualification: "changed"`. Capacity is 1,100 requests. The offline
rehearsal `pnpm run test:acceptance hexdeck-census` replays the shipped plan
against a two-page synthetic envelope around the 100 unchanged listings of pages
1 and 7.

## Intended full-import scope, not executed

The Images-format search exposes 19 pages of 50 rows (940 listings) with
documented sort fields; each listing carries `uuid`, `name`, `setTag`,
`setNumber`, rarity, energy/power/Might, domains, types, super types and search
tags. A reproducible census would freeze every page in one dated pass, compare
`uuid`, `setTag` and `setNumber` across pages, and compare each pair against the
retained Riot inventory. Linking or admission needs a surface with rules text,
artist, finish and language, none of which the listing provides; the search
query parameter must be established from the client rather than guessed. Those
are proposed steps, not measured counts or an installed capability; this pilot
establishes neither launch coverage nor Go-Live readiness.
