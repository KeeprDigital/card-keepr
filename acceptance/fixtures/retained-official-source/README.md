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

These files are evidence snapshots, not synthetic success envelopes and not
rewritten HTML examples. Under ADR 0004 every fixture is exercised against
the single current Source Adapter Version per Source Lineage before Go-Live
(ADR 0008); fixtures that only a retired parser
generation could read are removed together with that generation.

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

The optional-card-field fixtures were captured on 2026-08-11 UTC (cold,
polite user agent, no redirect following) after the second full-scale
Fusion World run failed on `detail.php?card_no=E-148`:

- `fusion-world-en-card-detail-energy-marker.json` and its `_p1` variant
  retain the live Energy Marker detail pages, which publish no rarity
  block at all; `fusion-world-en-card-detail-promo.json` retains a
  PR-rarity promo detail proving every non-Energy-Marker family still
  publishes its rarity.
- `digimon-en-card-list-related-qa-leaf.json` retains the AD-01 leaf whose
  Q&A answers nest a "Related Cards" list inside the answer container;
  `digimon-en-card-list-appmon-leaf.json` retains the LM-08 leaf with the
  Appmon crossover vocabulary ("Multicolor 2 from Stnd." digivolution and
  "DP+3000" Link DP); `digimon-en-card-list-promo-leaf.json` retains the
  P-numbered promo leaf whose related-card identities carry a trailing
  ideographic space and whose digivolution requirements join colours
  without a separator.

The fusion live-shape fixtures were captured on 2026-08-12 UTC (cold, polite
user agent, sequential requests about one second apart, no redirect
following) after the third full-scale Fusion World run failed on five live
page shapes (issue #55):

- `fusion-world-en-products-hub.json` retains the complete live
  `/fw/en/products/` hub (byte-identical to the bytes the failing run
  retained), whose AVAILABLE NOW / COMING SOON statuses publish as anchored
  `id="available"` / `id="comingsoon"` sections with an exact anchor-list
  navigation instead of the status-attributed markup the
  pre-live-shape generation required. `fusion-world-en-products-page2.json` and
  `fusion-world-en-products-starter-tag.json` retain a paginated page and a
  tag-filtered leaf proving the same section shape across the discovered
  listing URLs.
- `fusion-world-en-card-detail-errata-skills.json` (SB01-039) retains a
  Battle Card whose Skills label carries the publisher's face-scoped
  `(Errata Applied)` annotation with a pinned Errata Notice link nested in
  the annotated data cell; `fusion-world-en-card-detail-errata-leader.json`
  and its `_p1` variant (FS10-01) retain the Leader whose back face alone is
  annotated; `fusion-world-en-card-detail-errata-traits.json` (FP-088)
  retains the promo whose Special Traits label is annotated.
- `fusion-world-en-product-winter-booster.json` retains
  `/fw/en/products/01_477.html`, whose Release Date publishes the
  season-precision "Winter, 2026".
- `fusion-world-en-legality-history-news.json` retains the pinned
  legality-history publication `/fw/en/news/01_399.html`: one exact
  restriction lift (FB02-013) with a stated TCG change date of
  March 14, 2026 and a digital-version change tied to a game update rather
  than a calendar date.

The ten policy/legality-named captures remain historical raw evidence for the
adapter regression census. ADR 0014 removed tournament eligibility from the
catalogue. They are excluded from future recapture only after the
[complete caller audit](../../../../docs/reviews/official-source-recapture-2026-09-09.md).
The One Piece rules and DON!! rules hubs, Digimon rules hub, Gundam news/errata
pages, and Fusion World Errata Applied card details remain monitored for current
card-content and Errata parsing. No golden or regression hash was replaced.

## Weekly recapture and digest drift

`.github/workflows/official-source-recapture.yml` runs every Tuesday at
04:23 UTC and through `workflow_dispatch`. It verifies the 60 top-level JSON
capture records, excludes the ten audited eligibility-only URLs, and fetches each
remaining distinct `source_url` once, sequentially one second apart with a
30-second request timeout and 16 MiB body bound. It follows no redirects.

Every new capture retains the complete response in a digest-checked `.body` file
and separately records the exact original retained range. The current adapters
compare full observations (including sidecars) and discovered requests against
the original full golden. When a range fixture has a complete golden of the exact
same original response digest, that supplies its missing baseline bytes. Otherwise
changed whole-response meaning remains unresolved. Standalone normalized HTML
fragments remain parser examples, not recapturable HTTP goldens.

After `pnpm install --frozen-lockfile`, use a fresh output directory:

```sh
node scripts/recapture-official-bytes.mjs /tmp/official-source-recapture
```

The report distinguishes `unchanged`, `cosmetic_drift` (exact current adapter
outputs equal), `semantic_drift` (observations or discovery changed),
`structural_drift` (current response rejected), `unresolved_drift` (baseline or
complete bytes unavailable), `integrity_failure`, `transport_failure`, and
`out_of_scope`. All actionable results fail the job; cosmetic drift keeps the raw
bytes and goldens unchanged. No image query strings or optional evidence fields
are normalized away. These bounded interface checks do not establish full
Supported Game coverage.

Artifacts are retained for 14 days. A failing job opens or updates the recapture
issue and the Actions summary lists unresolved findings. Preserve evidence needed
for review before artifact expiry. Reassess a downloaded artifact without fetching:

```sh
node scripts/assess-official-recapture.mjs /tmp/official-source-recapture /tmp/new-assessment.json
```

The [9 September assessment](../../../../docs/reviews/official-source-recapture-2026-09-09.md)
records original and fresh evidence archives, the ten-capture caller audit,
current failures and exact remaining acceptance. Golden replacements require
reviewing real changed bytes and rerunning their adapter contracts; none were
replaced for #267. Closing the issue also requires useful successful monitoring
from the default-branch schedule. A successful manual run alone does not prove
that schedule ran.

A quiet schedule is not evidence of success. GitHub can disable scheduled
workflows in public repositories after 60 days without repository activity;
schedules also run only from the default branch and may be delayed. Check
monthly and after a long quiet period:

```sh
gh workflow view official-source-recapture.yml --repo KeeprDigital/card-keepr
gh run list --workflow official-source-recapture.yml --limit 3 --repo KeeprDigital/card-keepr
```

The workflow must be active and its newest scheduled run no older than one
week. Re-enable a disabled workflow and manually run it once:

```sh
gh workflow enable official-source-recapture.yml --repo KeeprDigital/card-keepr
gh workflow run official-source-recapture.yml --repo KeeprDigital/card-keepr
```

See [GitHub's schedule rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
and [disable/enable guidance](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

Use a fresh output directory for each manual recapture. The tool rejects a direct
or symlink alias of the golden directory and creates each capture/report
exclusively, so existing output files or symlinks cannot overwrite retained bytes.

### Reviewed monitoring baselines

The top-level captures remain historical parser regression evidence. After an
explicit byte/output review, `monitoring/baselines.json` may select a separate
complete capture for a monitored URL. Each `<original-name>.json.gz` contains
ordinary gzip-compressed capture JSON with exact original HTTP body bytes,
metadata and SHA-256 digests; the manifest pins the complete body digest and
links the review. The recapture command uses these reviewed baselines by default,
validating completeness, URL and digests before comparing current adapters.
It never rewrites either the historical fixtures or monitoring baselines.

The report's `category` and `actionable` describe the monitoring comparison.
`baseline_file` and `baseline_full_body_sha256` identify its exact evidence.
The older `status`, `differences` and `expected_full_body_sha256` continue to show
the byte comparison against the top-level regression capture; consequently a
reviewed source may correctly have `status: drift` and `category: unchanged`.
Raw comparison still includes all observations, raw source sidecars and
requests. Printing Image query parameters and optional source values stay exact.
Two reviewed display equivalences are reported separately: complete Fusion
Product-item permutations within the same status section, and a version token
on three exact decorative Gundam collaboration thumbnail paths. Every other
content, status, URL and token remains subject to exact comparison.

Offline replay preserves historical comparison by default. To explicitly use
the reviewed monitoring baseline, append `--reviewed-baselines`:

```sh
node scripts/assess-official-recapture.mjs /path/to/artifact /tmp/new-report.json --reviewed-baselines
```

The [September review](../../../docs/reviews/official-source-recapture-2026-09-09.md)
records each of the first twenty selections and the first complete Gundam
baseline. It does not claim whole-response equivalence for the earlier partial
Gundam capture. Manual replay or recapture success does not satisfy #267's
required successful default-branch scheduled run.
