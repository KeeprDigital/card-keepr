# Official Source recapture assessment — 9 September 2026

Issue [#267](https://github.com/KeeprDigital/card-keepr/issues/267) remains open.
The assessment uses current adapters from cleanup commit
`a14a803434dcc7bb150802dad3476989d0f61355`, without replacing any golden bytes.
This is bounded retained-source monitoring, not an enabled-source readiness claim;
[#240](https://github.com/KeeprDigital/card-keepr/issues/240) still needs the complete journeys.

## Preserved evidence

The original scheduled [run 34207274268](https://github.com/KeeprDigital/card-keepr/actions/runs/34207274268)
ran commit `0bb3b7d26c6744b4c037d788e6b45c334ae8aa83` and reported 59 byte drifts,
one unchanged response, no fetch failure and no invalid golden. Its downloaded
60 capture records and original report are preserved unchanged in
`acceptance/fixtures/retained-official-source/history/2026-09-09/run-34207274268.tar.gz`.
Archive SHA-256: `a4eef63a75626dde87d8826a871a46b94bedbf14a61454403a1ace27a270134c`.

The old recapture saved only the previous retained byte range, even for originally
complete goldens. Of the 60 new records, 35 omit part of the new response and only
25 are complete. The adjacent `run-34207274268-assessment.json` records 17 cosmetic,
two semantic, 30 unresolved, one unchanged and ten excluded eligibility captures.
Missing bytes cannot be reconstructed from the full-response digest.

A new sequential, read-only recapture on 9 September 2026 retains full responses
as well as the old exact-range records in `current-capture.tar.gz` in the same
history directory. Archive SHA-256:
`ee5d3f1b4a195cd8fd3f127d95f1317a26ff2882571a8245a758c622a5417198`.
`current-assessment.json` is the replayable actionable report with exact current
adapter observation/discovery digests, changed paths and representative values.
The archives are retained evidence, not new goldens.

| Current assessment | Captures |
| --- | ---: |
| Cosmetic bytes; exact current observations and discovery equal | 29 |
| Semantic observations or discovered requests changed | 16 |
| New structure rejected by current adapter | 1 |
| Baseline or whole-response comparison unresolved | 3 |
| Unchanged | 1 |
| Eligibility-only URLs excluded; retained integrity still checked | 10 |
| Transport / retained-evidence integrity failures | 0 / 0 |

## Changed real bytes reviewed

All 49 changed active captures were assessed through the current `parseBytes`
and `discoverRequests` interfaces. Successful comparisons include complete
source sidecars and request headers; no publisher field, image query string or
unknown optional value is removed to make the comparison pass. Cosmetic means
equivalent at these adapter interfaces, not proof about every meaning a publisher
might attach to unparsed markup. Raw responses stay available for inspection.

- Ten Fusion World card detail pages retain their exact observations and image
  discovery. Their token and CSS version bytes change. The other cosmetic
  captures retain exact current adapter outputs; the single unchanged capture is
  One Piece's existing 343-byte OP17 meta-refresh stub.
- Four Digimon card leaves retain identical parsed card observations but discover
  changed product navigation/image requests. Digimon's root adds a category
  (`522038`) and changes publication links; its parsed summary count grows from
  98 to 99. Gift Box and EX-01 product pages change discovered navigation assets,
  including `?260604` to `?260818`; these remain semantic discovery drift.
- Three Fusion World product details change discovered related products, and its
  card root changes linked products (including FB11). The products hub moves ST01
  to AVAILABLE NOW and adds four upcoming publications with a literal `.` RELEASE
  cell. The current parser rejects the new hub with
  `Unrecognized official Release date: ..`. No date is inferred.
- The two paginated Fusion World product goldens parse, but their
  `discoverRequests` calls already fail with
  `Official Source Fusion World category discovery is unavailable.` This is an
  unresolved baseline defect. The request IDs match the existing
  `fusionProductListingFixtures` roles. Production consumes discovery from every
  non-image HTML snapshot in `source-evidence-parsing.ts` through
  `extractBoundedAdapterPage`, including dynamic listings.
- Gundam GD02-016 changes its image query from `?260710` to `?260818`; One Piece's
  two card lists change printing image queries from `?260731` to `?260828` and
  update Recording options. These affect evidence-bearing image identities and
  remain explicit semantic drift; a query change alone proves no new Printing.
- Gundam's errata listing changes collaboration-news links/order and labels.
  GD05's product detail adds a Rarity breakdown (138+10 Card Types), retained as
  optional evidence. Its partial GD02 listing has no complete original golden;
  whole-response equivalence remains unproven even with the new full capture.

## Ten policy/legality capture caller audit

All ten files remain unchanged. Their only executable capture consumer is the
`adapter-retained-observations.spec.ts` directory census, which deliberately
invokes current adapters under its full identity matrix and checks the matching
`adapter-retained-observations.json` hashes. The generic recapture previously
fetched every top-level JSON. The raw-contract shared helper loads explicitly
selected slugs; none of these ten appears in its current caller lists. Fixture
imports in `test/support/fake-publisher/retained-bytes.ts`, the ingestion capacity
helpers and runtime capture-failure tests use card/discovery fixtures only.
The old audit JSON and README references are historical documentation.

| Capture | Current scope decision |
| --- | --- |
| `digimon-en-policy.json` | Restriction list excluded by ADR 0014. |
| `fusion-world-en-policy-live.json` | Restriction publication excluded. |
| `fusion-world-en-policy-detail.json` | Restriction publication excluded. |
| `fusion-world-en-legality-history-news.json` | Restriction history excluded. |
| `gundam-en-asia-policy.json` | Rules hub formerly used for eligibility; current Errata discovery uses news hub. |
| `gundam-en-us-policy.json` | Same US-locale decision. |
| `gundam-en-asia-policy-detail.json` | Restriction article excluded. |
| `gundam-en-us-policy-detail.json` | Restriction article excluded. |
| `one-piece-en-policy.json` | Old restriction URL redirects; outside accepted card-content scope. |
| `one-piece-en-block-policy-topic.json` | Block eligibility policy excluded; printed Block icon facts remain in card fixtures. |

The One Piece rules and DON!! rules hubs, Digimon rules hub, Gundam news hubs and
errata listing, Fusion World Errata Applied card details and all card/printing
fixtures remain monitored. No policy-named fixture was physically retired and no
regression baseline was regenerated. Excluded captures are still digest-checked
before the scheduled job skips their URLs.

## Validation and remaining acceptance

TDD at the existing recapture function and registered adapter seams proves
complete-response retention, HTTP failure separation, shared-URL output integrity,
cosmetic versus card-content changes, structural rejection, excluded-capture
integrity, and offline partial/corrupt evidence handling. The focused Node checks
pass. Typecheck and the full domain suite pass (44 files, 246 tests). No workerd,
Miniflare or live environment mutation was performed. The coordinator owns full
runtime validation after the #271/#272 baseline and fixes.

The updated weekly workflow installs the current locked adapter dependencies,
runs the recapture contracts, retains complete responses and produces an Actions
summary that lists actionable classifications. Cosmetic output equivalence can
pass while the bytes stay preserved; semantic, structural, unresolved, integrity
and transport results fail. Manual replay is not scheduled proof.

Before closing #267: fix the verified adapter failures, review/resolve semantic
changes and the incomplete Gundam baseline, integrate through required checks,
then obtain a successful default-branch scheduled run and coordinate enabled-source
readiness with #240. The new manual capture intentionally exits nonzero because
these findings are unresolved. The old script's circular CLI import was caught in
a local attempt (exit 13 before fetching) and removed before the successful fresh
capture. No interrupted check is being counted as a pass.

## Adapter corrections after the first monitoring commit

The follow-up implementation resolves the two verified Fusion World defects.
Only the literal `.` RELEASE token in the Fusion World product listing maps to
`{ precision: "unknown", value: null }`; the original raw cell remains explicit
unmapped evidence. Other unsupported date tokens still fail closed. Existing date
precision, publication status, Card facts and shared normalization are unchanged.

Dynamic Fusion World Product listings now discover their Product pagination and
details without requiring a Card category facet. This exception requires both the
dynamic listing role and the registered Product-listing origin/path. Other games
and an explicitly wrong Card-search role retain their previous fail-closed guards.
The complete bounded extraction seam consumes actual requests in regression tests.

The observation census changes exactly three hashes: the historical Fusion World
products hub, page2 and starter-tag captures. A before/after matrix audit confirmed
each changed output is only `discover:listing:<digest>`, previously a category
error and now respectively 33, 40 and 32 discovered requests. Their bytes and all
other 66 fixture outputs remain identical. These are deliberate behavior changes,
not golden replacements.

`fixed-adapters-assessment.json` replays the same preserved September capture with
the corrected adapters: 29 cosmetic, 19 semantic, one unchanged, ten out of scope,
one unresolved (the incomplete original Gundam listing), and no structural,
transport or integrity failures. The three repaired product captures now expose
actual semantic changes for review instead of hiding them behind parser errors.
All semantic drift remains actionable; the monitoring job therefore correctly
stays non-green until the evidence review and baseline decisions are complete.

Focused regressions include the two reproduced failures and explicit invalid-date
and wrong-role checks. After updating only the audited three observation hashes,
the full domain suite passes (45 files, 250 tests), 12 Node recapture tests pass,
and typecheck passes. The initial full-domain rerun correctly failed against the
old three discovery hashes; that failed run is not counted as final validation.

## Card-bearing playmat bundle found during semantic review

Both official Fusion World Product details `/fw/en/products/03_240.html`
(Limited Edition 02) and `/fw/en/products/01_331.html` (Limited Edition 01)
explicitly list `Playmat x 1` and `Card x 1` under Contents. Their complete raw
responses are retained beside this review's other history captures. The shared
accessory predicate previously excluded these Products because their titles
contain `PLAYMAT`. A Fusion-only classification policy now recognizes the exact
publisher `PLAYMAT & CARD SET` vocabulary before applying the existing accessory
vocabulary. Both listing and detail use that policy; other games retain their
existing classification. No Card identity or date is inferred from the bundle.

The retained September listing regression failed before the correction and now
proves Edition 02 is an announced Product with unknown Release date, both raw
detail pages retain their Card-bearing Products, and sleeves remain excluded.
The historical observation census changes only the Fusion products-hub hash:
three parse identities now preserve Edition 01, whose retained listing gives
April 18, 2026 and AVAILABLE NOW, instead of an accessory context. The full
before/after outputs were inspected; all discovery outputs and the other 68
fixtures remain identical. The first full-domain check failed against that old
hash as expected; this was reviewed before updating the single expectation.

Independent reviews of adapter commit `6a258fb66a1e2c712e4328e47ef89b0af8064a58`
against `c7440ae7` reported no actionable findings: Standards by the toolchain
agent and Spec by the capacity agent. They correctly retain the actual scheduled
run as an outstanding #267 gate. The bundle correction and reviewed monitoring
baseline are subsequent changes requiring their own review.

## Complete Gundam capture role correction

The new full GD02 listing includes a Products navigation link omitted by the old
retained range. The current adapter classified `/asia-en/products/list.php` as
`product_detail`, although that exact URL is the registered Products surface.
This is a concrete acquisition defect: discovered IDs include the role, so
`appendDiscoveredEvidenceRequests` cannot deduplicate it against the surface
request; the dynamic detail role takes precedence in the decoder. A fresh exact
Products-root capture parses with `gundam-en-asia:products` and rejects the
incorrect detail identity with `Product detail heading does not match its
official title.` Both complete raw responses are retained as gzip JSON history.

The narrow discovery correction excludes only the two locale Products root URLs
from detail classification; registered Products surface collection and GD05
Product-detail discovery still work. The regression failed before the change
and passes after it. The historical identity matrix changes 17 Gundam hashes;
an exhaustive before/after comparison verifies all 68 changed outputs remove
exactly one root-URL detail request, with all parse results and every other
request identical. Top-level raw captures remain unchanged. The first full
suite correctly failed against those historical hashes before this audit.

## Reviewed monitoring selections

After the source corrections above, twenty complete captured responses are
selected in `monitoring/baselines.json`; none of the top-level regression bytes
is overwritten. Its per-file digest, URL, retrieval time and review reason bind
each selection to the complete September response in `current-capture.tar.gz`.
`reviewed-semantic-changes.json` retains per-capture Card, Printing and Product
comparison counts/digests, changed Product catalogues and complete request
additions/removals using the corrected current adapters. Exact sidecar changes
remain in the original report and full raw evidence. These selections accept
actual publisher changes for future monitoring; they do not prove image-byte
identity, infer new Printings, or establish enabled-source readiness by themselves.

| Captures | Reviewed official evidence and decision |
| --- | --- |
| Four Digimon card leaves: appmon, BT01, promo, related QA | Respectively 1, 24, 19 and 5 Card/Printing facts remain identical. Category `522038` and `/images/products/pack/ver26/thumb.png` are added in raw navigation. Accept the exact discovery additions. |
| Digimon root | The same category is present in the source; summary count changes 98 → 99, with new publication links and image navigation. No card facts are inferred at the root. |
| Digimon Gift Box and theme booster | Their Product/Release facts remain identical. Navigation adds Gallantmon/Imperialdramon sleeves, WC26–27 playmat and Scramble premium collection; 17 existing image queries change `260604` → `260818`. Accept navigation evidence without asserting newly discovered detail contents. |
| Three Fusion Product details: starter, story and winter | Product/Release facts remain identical. FB11 `01_422.html` is added; FB08 `01_294.html` is replaced where it appeared in navigation. |
| Fusion card root | All 172 listing observations retain their Product catalogue. Raw category `583011` adds FB11 discovery; corresponding source links change. |
| Fusion products hub, page2 and starter tag | ST01 moves to AVAILABLE NOW with its unchanged 2026-08-21 date. Raw upcoming entries add Broly/Vegeta sleeves (accessories), PLAYMAT & CARD SET Limited Edition 02 and Premium Card Collection 03 (Card-bearing Products). The literal `.` dates remain unknown, with raw evidence retained. Older FB07/FB08 and other entries move between pages. Product pagination remains followed, so a page move is not a Product deletion. |
| Gundam GD02-016 detail | Card/Printing facts are identical; image query changes `260710` → `260818`. Accept the new evidence-bearing image request without inferring image equality or a new Printing. |
| Gundam GD02 complete listing | Establish the first complete monitoring baseline: 187 detail requests and 188 image requests are now retained. The earlier partial response cannot prove whole-response equivalence; this historical limitation remains explicit in the comparison artifact. The registered Products root is no longer scheduled under an invalid detail role. |
| Gundam errata listing | Product facts and Errata article discovery remain unchanged. Three collaboration thumbnail query tokens and source navigation ordering/labels change. Accept these exact source sidecars and requests. |
| Gundam GD05 Product | Product/Release facts and discovery remain unchanged. Raw Rarity adds `138+10 Card Types`, with 50 Common, 36 Uncommon, 32 Rare, 12 Legend Rare, 8 Special, 2 Token and 8 Special EXResource. Preserve this as optional source evidence. |
| Two One Piece card lists | Respectively 1 and 155 Card/Printing facts remain identical. Image queries change `260731` → `260828`; raw Recording `569117` is added to discovery. No new Printing is inferred from an image URL change. |

Replaying the preserved September capture against these reviewed baselines is
successful: 21 unchanged, 29 cosmetic and 10 out of scope; zero semantic,
structural, unresolved, transport or integrity failures. Replaying without the
explicit reviewed-baseline option still reports 19 semantic and one unresolved
capture, preserving the old comparison and Gundam limitation. A changed baseline
body, incomplete capture or digest/URL mismatch fails as an integrity error.

Independent review of `6a258fb6` → `92ce2549` is complete on both axes: coordinator
Spec review and toolchain Standards review each found no actionable findings,
independently verified four retained complete body digests and checked the
Fusion-only policy and both exact Gundam root URLs. These reviews do not assert
that the separate monitoring-baseline commit or required future schedule passed.

## Repeated capture and reviewed display equivalence

A fresh complete manual recapture after baseline selection exited 1, reporting
33 cosmetic, 4 semantic, 13 unchanged and 10 excluded captures. This failed run
is retained as `fresh-capture.tar.gz` and `fresh-before-cosmetic-review.json`.
It exposed recurring display differences rather than a new publisher Card or
Product fact. The four complete repeat responses are also retained individually
under `history/2026-09-09/cosmetic-repeat/` for focused regression checks.

The three Fusion Product pages reorder complete `prpductListItem cardCol` entries
within COMING SOON. This changes raw observation order, sidecar publication-link
order and the generic last-seen MSRP aggregate, while each complete item retains
its contents and status section. The comparison-only rule sorts exact complete
item bodies only inside the exact `prpductList` within each recognized AVAILABLE
NOW or COMING SOON section, then invokes the current adapter again. It neither
moves an item across statuses nor drops an item, field, value or unknown markup.
Unsupported list structure receives no equivalence. This rule is limited to the
three reviewed Fusion Product captures.

The Gundam errata page also regenerates a 32-hex `?_=` token on three decorative
collaboration thumbnails. Only those three exact HTTPS hostname/path pairs and
that exact single-query shape receive a comparison-only stable token. Every
observation and every other request remains exact; in particular actual Printing
Image URLs, changed paths and added query parameters remain actionable.

Both original raw responses must parse and discover successfully before either
rule is considered. Reports retain original body/output digests, changed paths
and values, with a separate `cosmetic_equivalence_rule`; the original evidence
is never rewritten. Exceptions during comparison leave the drift actionable.
The coordinator explicitly approved these narrow rules after reviewing the
repeated-capture findings. They improve the initial deliberately exact monitor
without turning unreviewed fields into ignored differences.

Reassessment of that same fresh artifact now passes: 37 cosmetic, 13 unchanged,
10 excluded and no actionable failures (`fresh-reviewed-assessment.json`). Node
regressions cover all four real repeat captures and prove changed Product names,
Release dates, MSRP content, movement across status sections, thumbnail paths,
extra query parameters, actual Printing Image query values, Card facts and
structural rejection remain actionable. The preceding failed fresh run remains
failed evidence; replay success is not claimed as a new network or scheduled run.

Fresh archive SHA-256:
`e76a43a83bb3447a523f5cabc1f967e20d3ac27eaa834c8777b69b6d906912da`.
Final focused validation passes 14 Node recapture tests. Most recent full domain
validation passes 46 files / 252 tests and typecheck; those production files
have not changed since. No heavy runtime test or live environment operation ran
in this lane. Full runtime validation and integration remain coordinator-owned.

## Reviewed hosted manual proof

Both independent reviews of `92ce2549` →
`afbd4495baeb86874eb3a481392c6a3b380dc40c` are clear: coordinator Spec and toolchain
Standards reported zero actionable findings. The Spec review independently
matched all twenty baseline bodies (2,091,639 bytes) to their original complete
capture artifact and checked URL, full range and digest integrity. Both reviewed
the limited cosmetic rules, raw-first parsing and negative contract cases.

After those reviews, manual workflow run
[34335244239](https://github.com/KeeprDigital/card-keepr/actions/runs/34335244239)
succeeded at exact commit `afbd4495baeb86874eb3a481392c6a3b380dc40c`. Locked install,
14 recapture contracts, actual network acquisition and artifact upload all pass.
The hosted report records 37 cosmetic, 13 unchanged and 10 out of scope, with no
actionable failures. Its complete artifact, report and GitHub run/job metadata
are retained as `manual-run-34335244239.tar.gz`,
`manual-run-34335244239-report.json` and `manual-run-34335244239.json`.
Archive SHA-256:
`453cb1581a2874a58f0132023115f3c849644bb28b4e9d1237977d0e77b566a3`.

This is `workflow_dispatch` on the reviewed feature branch, not `schedule` on the
default branch. #267 remains open until integration checks, the actual scheduled
run and enabled-source convergence through #240 meet its acceptance. The weekly
Tuesday 04:23 UTC schedule was not changed or simulated to manufacture that proof.
