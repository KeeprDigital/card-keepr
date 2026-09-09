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
