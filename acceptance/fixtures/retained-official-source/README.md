# Retained Bandai Official Source bytes

These fixtures were captured from the public URLs recorded in each JSON file
through 2026-08-05 Australia/Melbourne time; the `*-restructured-*`,
`*-hub`, `*-errata-listing`, `*-card-detail-*`, and `*-bt01-leaf` fixtures
were captured on 2026-08-07 UTC for the 2026-08 site-restructure adapter
generation (issue #55). `body_base64` is either the complete
unchanged HTTP response body (`range_start = 0` and
`range_end_exclusive = full_body_size`) or an unchanged byte range containing
the complete publisher `<header>` or one complete parseable publication
section. Range fixtures record their offsets, the
full response size and digest, and the retained-range digest. Tests decode the
bytes, verify `body_sha256`, and pass those exact bytes to the production
adapter.

The current Fusion World URL registered by the earlier adapter contract now
returns 404. Its complete response is retained as explicit negative evidence;
the current publisher-linked Rules page is retained separately. These files
are evidence snapshots, not synthetic success envelopes and not rewritten
HTML examples.

`one-piece-en-card-list.json` retains the complete live one-result Card List
response for the publisher's `series=569001&freewords=ST01-001` query. It
preserves the literal `<select name="series" id="series">` vocabulary, the
inline Card detail, and its discoverable Printing image.

`digimon-en-card-list-popup-fragment.html` retains the two complete adjacent
`EX12-021` and `EX12-021_P1` publisher popup records captured on 2026-08-04
from the exact live leaf
`/cards/index.php?search=true&category=522037&cardcategory=Digimon&color=Blue`.
It is a focused publisher HTML fragment used to prove that the registered
adapter consumes both the base and alternate-art Printing markup; line endings
and trailing whitespace are normalized for the repository fixture.

The 2026-08-07 restructured-generation captures are complete unchanged
response bodies fetched cold with a plain polite user agent and no redirect
following:

- `one-piece-en-restructured-discovery.json` retains the full live
  `/cardlist/?series=569116` page (the publisher's redirect target for
  `/cardlist/`): the duplicated header/footer navigation, the `series`
  facet used for Recording enumeration, all 155 inline Card modals — one of
  which (`OP16-020`) prints an explicit `-` Event cost — and the SP CARD
  rarity vocabulary.
- `one-piece-en-rules-hub.json` retains the `/rules/` hub that now links
  restrictions at `/news/restriction.html` and the Block Number System at
  `/topics/013.php` (its `/rules/block_icon/` page returns 404);
  `one-piece-en-block-policy-topic.json` retains that topics page.
- `fusion-world-en-restructured-card-search.json` retains the full live
  category leaf `/fw/en/cardlist/?search=true&category[0]=583301` with its
  "Filter by series" category enumeration, the 172-card listing, and its
  `detail.php?card_no=…` anchors. The three `fusion-world-en-card-detail-*`
  fixtures retain the live Leader front/back, `_p1` variant, and Battle
  detail pages. The live site publishes no EN errata surface:
  `/fw/en/rules/errata-card/` now returns 404 (see the historical negative
  evidence note above).
- `digimon-en-restructured-card-search.json` retains the live
  `/cards/index.php?search=true` root (the `/cardlist/` navigation target
  now redirects through `/cards/`); `digimon-en-card-list-bt01-leaf.json`
  retains a complete BT-01 leaf whose vanilla Digimon Cards publish no
  effect row and whose record count is proven structurally by `page-N`
  markers (the live leaves render no "Result N cards" total);
  `digimon-en-rules-hub.json` retains the `/rule/` hub with its pinned
  restriction and errata links.
- `gundam-en-asia-restructured-card-search.json` and
  `gundam-en-us-restructured-card-search.json` retain the live card search
  roots, which render an explicit "Please specify your search criteria."
  empty state plus the per-locale package enumeration instead of a card
  listing. `gundam-en-asia-news-hub.json` / `gundam-en-us-news-hub.json`
  retain the news hubs whose subcategory tabs (not errata-labeled links)
  now identify the errata listing, and
  `gundam-en-asia-errata-listing.json` retains the pinned
  `/news/?subcategory=news&tag=all&page=1` listing with its errata article
  and pagination anchors.

The `*-product-*` fixtures were captured on 2026-08-07 UTC (cold, polite
user agent, no redirect following) after the first full-scale Gundam run
proved the live product detail pages unparseable: every game's product
page now carries its identity in the document `<title>` (the leading
`<h1>` is the site logo), and the listings sweep accessory publications.
They retain, per game, a card product page, the accessory shapes the live
listings publish (Gundam card case both locales, US playmat, One Piece
sleeve), the codeless set shapes (Gundam 1st Anniversary Set, Digimon
Gift Box), the card-bearing Deck Build Box [SC01], the One Piece
meta-refresh booster stub (`op17.html`), and the Digimon region-scoped
release rows ("Europe/Oceania: December, 10 2021" with store-level
parenthetical annotations).

The live policy expectations intentionally follow the published scope rather
than capture time or article recency:

- One Piece's current-list heading states an exact April 10, 2026 effective
  date, so its five bans and three banned-pair rules retain that date and their
  exact effects.
- Fusion World's current detail states only “from March 2026”. Its eight Card
  targets are retained with an unresolved effective interval; no day is
  invented from the March 13 article date.
- Digimon's current affected-card summary contains two pair groups, three
  banned Cards, and fifty restricted Cards, but does not associate every
  carried-forward entry with one effective date. All 55 explicit target groups
  therefore retain an unresolved effective interval.
- Both Gundam locale details contain one banned Card, one restricted Card, two
  explicit pairs, and one twenty-Card predicate group. The July 24 article date
  does not state the list's effective boundary, so all five target groups per
  locale retain an unresolved effective interval. The issue-58 adapter
  generation (`gundam-en-asia@7` / `gundam-en-us@7`) additionally parses the
  open-predicate group ("a Unit card that is Lv.2 with cost 1, 2 AP, and
  2 HP, and without effects", future printings included) into one explicit
  `unresolved` rule whose scope names both `effective_interval` and
  `target_scope`; earlier generations keep failing closed on the compound
  policy.

The issue-58 captures were verified on 2026-08-11 UTC (cold, polite user
agent, no redirect following):

- Both Gundam locale `/rules/` hubs and `news/01_279.html` details returned
  byte-identical responses to the retained 2026-08-07 fixtures, so those
  fixtures remain the current live evidence for the `@7` legality contract.
- `one-piece-en-don-rules-hub.json` retains the fresh complete `/rules/` hub
  response (the earlier `one-piece-en-rules-hub.json` capture remains as the
  2026-08-07 restructure-generation evidence; the live page has since
  reworded its FOR BEGINNERS header navigation). The hub publishes rule
  PDFs, news notices, and the pinned restriction, block-policy, and errata
  links, and no DON!! content: the `one-piece-en@6` don-rules contract
  retains it as exact coverage evidence with a structurally complete empty
  Legality Rule observation and makes no comprehensive DON!! Printing claim.
