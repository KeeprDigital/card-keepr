# Riftbound DB bounded promo and overlap evidence

This is the retained evidence for [#331](https://github.com/KeeprDigital/card-keepr/issues/331).
The selected Source is **Riftbound DB**, operated at `www.riftbound-db.com`, with
Source Lineage `riftbound-db-en` and adapter `riftbound-db-en@1`. It is an independent
Source, not an Official Source. Its English pilot has unknown release region.
Riot remains the designated authority; registration does not qualify every record
or authorize any new acquisition.

## Retained bytes and access boundary

[manifest.json](manifest.json) retains eight responses captured on 14 September
2026 plus four subsequently selected image responses. The first eight were copied
without altering their bytes or capture metadata; only their relative body paths
changed. The homepage, linked frontend, Terms/About scripts, robots, both card
query responses and facets preserve the observed acquisition contract. Each body
has its original URL, request/response headers, status, capture time, length and
SHA-256. New image responses also retain completion times and original received
header files. Capture time is distinct from cached response Date/Age.

The retained May 2026 terms prohibit scraping or bulk export **in ways that harm
the service**. Separately, robots excludes `/api/` (the `/api/og-deck` exception is
for deck social images). Public availability and cache headers establish neither
an unrestricted bulk-import permission nor a developer API/stability/rate-limit
contract. The About page attributes card data/artwork to Riot; promo records also
retain explicit OpenRift card/printing IDs and original image origins. These are
attributable shared upstream facts, not independent corroboration.

The additional acquisition was exactly four sequential image GETs, 1.5 seconds
between responses and subsequent requests, 30 seconds per attempt, 5 MiB per body,
20 MiB aggregate, with identity encoding and no retries or redirects. All returned
200 and total **1,262,250 bytes**. No metadata was recaptured and no other image,
full crawl, outreach, Piltover Archive or HexDeck request was made. The exact
Eclipse URL came from the retained Riot response; it carries `accountingTag=RB`,
while DB's original locator has the same publisher asset path without that query.
The latter original locator remains unchanged in the source record. This does not
claim a second capture of the URL without the query.

## Actual pilot scope and qualification

The executable [pilot plan](../../../../docs/examples/riftbound-db-pilot-plan.json)
contains three exact roots: `/api/facets`, `/api/cards?set=PR&page=1&pageSize=3` and
`/api/cards?q=Bird&page=1&pageSize=3`. It discovers only the four inspected original
image locators. The adapter's Request Capacity is **7 unique requests**; it does
not follow either query's `hasMore`. The default registration has this same
bounded coverage. Successful completion means these selected surfaces closed,
not that PR, the search or all Riftbound DB cards were captured.

The PR response reports 29 results; Bird search reports 31. Six returned objects
contain five unique source IDs. Bird is byte-equivalent as a JSON object in both
responses, a real overlapping-query duplicate, not a manufactured source update.
The fifth unique record, Anivia – Primal, is retained outside the qualified
four-record selection as an unresolved source record. Its original/derivative
locators remain in raw evidence; its image was not selected or acquired.

| Record | Visible retained front evidence | Admission and unknowns |
| --- | --- | --- |
| Buff | English rule, +1 symbol, OGN, PROMO mark, League Splash Team | Unresolved Card/Printing association and exact physical issuance/finish. `Other` is not interpreted as Unit. `Ask a Rioter` remains a source distribution assertion. |
| Bird | English Token Unit/Bird, Might 1, Deflect, UNL·T02·P, PROMO, Six More Vodka | Unresolved identity versus Riot UNL-T02 and physical issuance/finish. DB's `champion=Bird` does not make it a Champion. Keeping/stripping `-P` establishes no canonical distinction. |
| Shadow Clone | English Token Unit, visible Might 0, Assault 4 rule, VEN·T05·P·EN, PROMO | JSON omits Might; the image observation is retained rather than silently filling the source field. Exact issuance/finish and identity remain unresolved. `Vendetta Vault` alone does not prove release. |
| Eclipse Herald | OGN·059/298, Unit, English wording, matching art/frame, stats 7/7/1, Kudos Productions | Qualified bounded match to the retained Riot record and publisher image. Owner admission/link still required for this supplementary Source. Finish, reverse face and original printed wording remain unknown. |

The adapter preserves complete source records, including `raw.openrift.cardId`,
`printingId`, `finish`, `artVariant`, `markers`, `publicCode`, `shortCode`,
`channelPath`, transformed display codes, original images and cached full/thumbnail
locators. No OpenRift key allocates a canonical entity. The three promo front
images are private **source-record image evidence**, with exact retained hashes;
they are not published Printing Images of an unqualified Printing. Static front
depictions do not independently establish physical issuance or foil. No back is
available. Unresolved records contribute no partial Game Profile, Card or Printing;
an identity exception cannot waive the required structure.

Eclipse Herald maps into the existing `riftbound@1` profile. Its qualified
publisher name and `OGN-059/298` code come from this specific retained Riot/image
comparison; there is no general name/code transformation rule. Changed source
IDs, image locators or qualifying structure require fresh qualification. The
retained Riot inventory has 1,189 returned records versus the publisher's stated
1,197; that existing eight-record discrepancy remains unexplained. The absence
of a Shadow Clone record is confined to that retained return set.

## Repeatable native journey

`pnpm run test:acceptance riftbound-db-catalogue` replays the three unchanged DB
responses and four actual images through production collection, reconciliation,
owner proposal/link decisions, whole-candidate approval, published API reads,
export and actual isolated SQL import/restore. It starts with an Eclipse Herald
Riot predecessor and a real publication/backup checkpoint. To bound that setup,
only its pagination envelope is synthetic around the unchanged Riot record from
`2026-09-08-riftbound/raw/cards-200.json`. This setup is not a claim that a live
Riot request returned one record. All DB bodies are unchanged.

The journey must retain two distinct observations for the one Bird proposal,
reject attempted admission without Card/Printing structure, keep the three promos
and Anivia unresolved, and link only the existing Eclipse Herald Printing. The
accepted catalogue therefore gains source overlap, **no new qualified promo
Printing**. Admission/link and whole-candidate approval remain separate actions;
identical overlap preserves the consumer revision and export identity while a
new verified backup retains the fresh administrative evidence and decisions.
Exports contain accepted data and explicit unknowns, with administrative evidence
remaining private. Tests and source selection do not install production decisions.

## Intended full-source scope, not executed

The intended import is all eligible English physical-card records from every
agreed source bucket, rather than PR alone. The retained facet inventory is
`ARC,JDG,LGC,OGN,OGS,OPP,PR,RAD,SFD,UNL,VEN`. The frontend treats JDG/OPP/PR as promo
buckets; these are Source Coverage partitions, not proven Products or Printings.
It exposes q/set/type/supertype/region/champion/keyword/subtype/rarity/domain/artist/
variant/cost/might/power/sort/page/pageSize. Multi-value filters are comma-separated.
Listings request 30; a separate UI operation requests 80 and stops at no hasMore
or page 200. These are observed client choices, not server guarantees.

A reproducible future bounded proposal would pin one facet capture, use exact
`set=<bucket>&page=<n>&pageSize=30` queries with the same recorded default ordering
and no other filters, and traverse each of the 11 pinned buckets. Cap each bucket
at 200 pages: at most 2,200 listing responses, 66,000 record occurrences and one
separately bounded original-image request per unique eligible source record, plus
one facets response. These are proposed ceilings, **not measured counts or an
installed full-import capability**. Changed facets require a revised declared
plan. A cap reached with hasMore, a failed request, repeated/nonadvancing page,
changed total or unresolved ordering makes the inventory incomplete. Compare raw
record IDs and semantic contents across pages/buckets, retain duplicates and
contradictions with both provenances, and never deduplicate by display code.

Before execution, establish acceptable access volume/pacing, a stable ordering or
snapshot contract and the server's supported bounds. Retain each page and its
actual pagination metadata. There is no established API filter for English,
issued, physical cards; previews are included by default in the UI. Eligibility
needs record-level language/issuance evidence and explicit exclusions or proposals;
`previewed:false`, EN suffixes and English prose alone are insufficient. Missing
image roles/treatments, unstable IDs, unidentified locale/region, missing facets,
preview exclusions and omitted pages remain counted gaps. The current pilot and
its seven-request adapter do not establish this full scope, launch coverage or
Go-Live readiness.
