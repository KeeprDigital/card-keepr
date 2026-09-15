# Pokémon scope qualification

These 32 unmodified response bodies (2,720,696 bytes) support bounded parser,
profile and discovery qualification for [#329](https://github.com/KeeprDigital/card-keepr/issues/329).
They are research captures, not a complete Ingestion Run, publication or refresh.
The [manifest](manifest.json) retains each request URL, response status, capture
times, headers, length and SHA-256. Parent body references resolve within this
fixture. Bodies were independently checked against their retained digests.

The pack contains eleven Set details, ten full Card records, seven original scans,
two fresh discovery roots, one earlier English inventory used to discover the
first four Sets, and the first-party asset contract. Reusing an earlier body
preserves its actual date. These responses do not form an atomic source snapshot.
The metadata/image captures were sequential with at least one second between
requests, no redirects or automatic retries, a 30-second request timeout, and a
1 MiB response bound. Raw captures retain their original qualification status;
subsequent image inspection is described below.

## Discovery and count meaning

The fresh English list has 218 Sets. The separately declared Pocket endpoint
identifies 15 matching memberships, leaving 203 non-Pocket candidates. The complete
203-set research census is retained with the issue's workload evidence; this
fixture keeps the bounded examples used by automated tests.

TCGdex's [pinned compiler](https://github.com/tcgdex/cards-database/blob/62189aec5f9f4c8a929e31a8ddec062419e3ed83/server/compiler/utils/setUtil.ts#L101)
uses `total = max(official, cards.length)`. Its
[English record selection](https://github.com/tcgdex/cards-database/blob/62189aec5f9f4c8a929e31a8ddec062419e3ed83/server/compiler/utils/cardUtil.ts#L196)
requires exact English source names; images and legality do not filter membership.
All 203 captured Sets match that formula: 21,068 unique enumerated IDs versus
21,296 summed totals. The exact deployed API commit is not attested.

Six source-content limitations remain explicit: `wp` 0/7, `jumbo` 0/160, `sp` 0/10,
`rc` 0/25, `tk-sm-l` 18/30 and `mfb` 34/48 (enumerated/reported). The count floor
cannot detect omitted records beneath it. The difference does not establish 228
missing English physical Cards. Set dates alone do not prove each record was
physically issued. Tests also preserve the exact `tk-ex-latia`/`8` boundary and
the leading zero in `swsh9-053`; no collector-number range is synthesized.

## Inspected content

| Records | Evidence and limits |
| --- | --- |
| `base1-98`, `base4-126` | The scans show Basic Fire Energy, respectively first-edition Base Set 98/102 and Base Set 2 126/130. They support this resource-design equivalence and distinct Printings, not a universal same-name merge rule. Metadata uses `energyType: Normal` and `stage: Basic`, without an effect or types. |
| `base1-96` | The first-edition 96/102 scan and text establish two Colorless Energy and explicitly exclude Basic Energy. |
| `swsh9-147` | The Professor's Research scan establishes Supporter and “Discard your hand and draw 7 cards.” Metadata regulation D contradicts the visible F; neither value is silently chosen or blended. |
| `base1-94`, `tk-ex-latia-8` | Historical Potion omits Trainer subtype. Trainer Kit Potion supplies Item and an inapplicable retreat zero. No scan for either is in this pack. |
| `base3-62` | Mysterious Fossil's first-edition 62/62 scan visibly prints TRAINER and 10 HP. The source agrees on category and HP and omits subtype. Its effect makes it count as a Pokémon while in play; the Card retains its Trainer classification and full conditional text. This qualifies its printed HP, not arbitrary Trainer stats or every listed treatment. Detailed normal variants' `foil: galaxy` labels remain unqualified source claims. |
| `base1-5`, `swsh9-053` | Both scans show Clefairy, but 40 versus 60 HP, Colorless versus Psychic, and different attacks establish distinct content. Name equality does not merge these Cards. |
| `swsh9-109` | TCGdex Garchomp includes corrected Sonic Slip and holo/reverse treatments. It overlaps the [official pilot](../2026-09-14-pokemon/README.md); this metadata alone does not assign the pilot Printing to either treatment or establish a precise scan. |

The seven scans are whole original `high.png` responses from evidenced image bases,
using the retained [asset contract](raw/tcgdex-assets-contract.body). A shared scan
does not depict every detailed treatment. Image associations, printed wording,
source metadata and current corrected Card wording remain separate evidence.
No synthetic image or altered metadata is presented as a real capture. Tests
that alter these bodies to exercise rejection explicitly construct those changes
in memory and leave the retained bodies unchanged.

The official publication scope remains the pilot's exact three publications and
one linked Garchomp image. This pack does not expand that source selection.
