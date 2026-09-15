# Bounded Pokémon evidence

Retained public responses for [#328](https://github.com/KeeprDigital/card-keepr/issues/328).
The [manifest](manifest.json) identifies exact requested/resolved URLs, UTC capture
times, request/response headers, status, byte length and SHA-256. Bodies are
unmodified. The coordinator's eight earlier responses were hash-verified before
copying; five additional requests captured two healthy REST records and three
images. Ordinary tests replay these bytes without live source access.

## Selected scope and authority

`tcgdex-pokemon-en@1` belongs to `tcgdex-pokemon-en`, operated by TCGdex, with
`pokemon@1`. Its pilot scope is exactly English physical `svp-051` and `base1-4`,
including each record's detailed treatment array. The selected Source Authority
areas are card facts and Printing details. No Pokémon TCG Pocket (`tcgp`) or other
digital-only record belongs to this allowlist. The complete declared pilot checks
two Cards; it does not check the whole English catalogue.

`pokemon-official-en@1` belongs to `pokemon-official-en`, the selected English
publications of The Pokémon Company International. Its concrete scope comprises
the 151 Pokémon Center Elite Trainer Box Product page, Garchomp Brilliant Stars
109/172 card page, and the 9 February 2022 Garchomp correction article. It is
selected for corrected card content; its Card and Printing evidence remains
supplemental. Publisher ownership, source selection, authority, and qualification
are separate. A new official-only Printing in this pilot requires owner admission,
followed separately by approval of the whole candidate.

Garchomp appears only in the selected official pilot scope. This does **not** mean
TCGdex lacks Garchomp globally. Both Snorlax treatments overlap TCGdex and official
Product evidence. No unique global coverage claim is made. The Product text names
both treatments but supplies no collector-number/individual-image join; that gap
remains explicit. English and a `/us` publication path do not establish a Product
Release region. No release region is inferred for either Source.

## Acquisition and limitations

The [REST Card route](https://tcgdex.dev/rest/card) returns JSON through public
HTTPS GET without credentials. The two selected API URLs and their reported
[high PNG asset URLs](https://tcgdex.dev/assets) require at most four distinct
requests per TCGdex run. The official scope requires three HTML requests and one
linked Garchomp PNG. Each adapter limits a snapshot to 1 MiB and its total request
capacity to four. Collection uses the repository's bounded transport retries and
host pacing. The research requests used an identifying application User-Agent,
explicit Accept and identity encoding, a 25-second timeout, 1 MiB response cap,
and two seconds between requests. No automatic live retry was used.

[TCGdex's FAQ](https://tcgdex.dev/faq) documents no hard rate number, asks for
considerate use and caching, and acknowledges evolving variant/marketplace
mapping. There is no established immutable `variantId` promise or universal
cross-reprint meaning for `id`/`localId`. Exact rich `variants_detailed` bytes,
including shared marketplace IDs, govern this pilot; coarse variant booleans
must not be multiplied into an invented Cartesian product. Prices, eligibility,
Pokédex species and cameo IDs remain source evidence outside Catalogue Data.
Unfamiliar optional fields must remain attributable with an actionable warning.

The two `source-*.json` files are pinned GitHub Contents responses for TCGdex's
database commit `5b6a2859f454972477a9953ffe5cb554d24c45e9`, not REST Card records.
The database and API have the same operator and are not independent corroboration.
No per-record original scan contributor was established. No paid, deprecated or
unselected provider was added.

Three earlier captures (`charizard-base1-4.json`, `snorlax-svp-051.json`, and
`pocket-series.json`) are HTTP 503 bodies containing `no available server`.
Their `.json` suffix does not make them usable Card fixtures. They remain failed
acquisition evidence, not source absence. The healthy `tcgdex-*.body` Card files
are separate later observations with their own provenance.

## Physical evidence

| Retained image | What is visibly depicted | Missing evidence |
| --- | --- | --- |
| TCGdex Snorlax root | Unstamped full-art Snorlax SVP 051 | Pokémon Center-stamped scan and reverse face |
| TCGdex Charizard root | First-edition stamp, shadowless frame, 4/102 and 1999 copyright | Unlimited, unstamped shadowless, 1999–2000 copyright scans and reverse faces |
| Official Garchomp | 109/172 with the original Sonic Slip wording | A later physically corrected Printing and reverse face |

The exact inspected image digests bind the treatment associations. A changed
image must not silently inherit that qualification. A shared catalogue root or
matching bytes do not make the other treatments equivalent. Snorlax is a playable
gameplay Card despite prominent/full-art illustration. The four Charizard
treatments stay distinct even though both shadowless records share TCGplayer
`106999` and Cardmarket `660224`.

Garchomp's normalized composite `BRILLIANT-STARS-109/172` combines the publisher's
evidenced set name and printed number under the Pokémon Game Profile. It is our
normalization, not a verbatim upstream global code. Exact set/title/number and the
publisher page locator remain private attributed evidence. Canonical Card and
Printing IDs remain persistent allocations. The correction targets that exact
Card, preserves its old wording, and does not establish physical corrected stock.

## Full import remains separate

[#329](https://github.com/KeeprDigital/card-keepr/issues/329) owns full selected-scope
coverage. A reproducible future TCGdex import starts with retained English series
and set inventories, excludes sets belonging to `tcgp`, and retains each included
set's complete Card enumeration before fetching deduplicated Card details and
images. [Pagination](https://tcgdex.dev/rest/filtering-sorting-pagination) requires
explicit page/item-count and stable sort parameters; verify closure, duplicates
and drift because snapshot-consistent pagination is not promised. Census requests
and bytes before setting launch capacity. Source Card counts are not physical
Printing counts. The three named official publications do not imply that all
official news, Products, cards or correction documents were checked.

Outstanding factual limits include variant-ID stability, precise scans for four
treatments, original scan attribution, exact release geography, and full-source
coverage. Capture/parser tests alone do not qualify publication or recovery; the
issue's owner lifecycle evidence must establish those separately.
