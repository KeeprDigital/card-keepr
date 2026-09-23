# Sources and owner decisions

Use `pnpm run keepr` from the repository root (shown as `keepr` below), with the
ingestion URL and administration key configured as in [setup](../../README.md).
Commands and input shapes are defined by the
[administration contract](../../contracts/ADMINISTRATION.md).

## Select and collect evidence

```sh
keepr source registry --json
keepr source authorities --json
keepr source collect --plan-file docs/examples/one-piece-two-source-plan.json \
  --budget-file OWNER_SELECTED_BUDGET.json --idempotency-key CAPTURE_INTENT --json
keepr source resume --run-id RUN --json
keepr source show --run-id RUN --json
```

The budget file contains `max_dispatches`, `max_source_bytes` (positive safe
integers), and a future ISO `dispatch_deadline`. Select finite limits for the
whole run across its Source Lineages. Every potential physical call consumes a
dispatch, including retries and revalidation. Raw-source exposure includes
verified retained body bytes and unresolved maximum-body reservations; it is
not wire traffic, all account storage or a financial limit. The deadline stops
new admission and does not cancel a call whose authority already escaped.

A refresh is incremental. Pages and roots with a retained ETag/Last-Modified
send a conditional request; a `304` is a counted dispatch charging zero bytes and
reuses the retained bytes. A Printing Image whose exact URL already has retained
bytes from an earlier run is skipped with no dispatch and no bytes; its attempt
records `source_image_unchanged_skipped`. `source show` counts both
(`revalidated_attempt_count`, `skipped_request_count`). A replaced image at an
unchanged URL is not detected until its URL changes.

Pacing adapts per host within the bounds each Source Adapter registration
records (`hostPacing`). `source show` lists every host the run touched under
`collection.pacing.limits` (kind, floor/ceiling, maximum and current
interval/concurrency, backoff and recovery counts) and the newest receipts
under `collection.pacing.events`. Repeated `rate_limited`, `unavailable` or
`latency` backoffs mean the source is struggling: let the run continue at the
slower pace or pause it; do not lower registration bounds to push through.
`SOURCE_HOST_PACING_INTERVAL_MS` only sets the floor for undeclared hosts.

Collection creation acknowledges the retained plan; resume dispatches its work.
Inspect `source show` for current progress and completion. Exact creation retries
return the original acceptance, even after the run advances.

`source show` returns a compact summary (`card-keepr-evidence-summary@1`) whose
size does not grow with the run: state, pause, request counts by lineage, role
and state, acquisition budget, capacity, pacing limits, the newest 20 pacing
receipts and failed images, and failure counts under `failures`. For
per-request detail, add `--requests`; it lists 250 Source Requests per page in
sequence order with their attempt count and latest attempt. Repeat with
`--after NEXT_AFTER` until `next_after` is null. `--full` returns the complete
status document with retained plans, snapshots, observation sets and
diagnostics; on a large run it is slow and large, so use it only when those
lists are needed.

`source show` waits 60 seconds; other commands wait 10 seconds. Override with
`--timeout-ms MS` on `source show` or `KEEPR_TIMEOUT_MS` for every command. A
timeout exits 9 with `runtime_timeout`, naming the endpoint and elapsed time.

To reinterpret a retained Source Snapshot, run `keepr snapshot reparse` with
`--snapshot-id SNAPSHOT --adapter ADAPTER --idempotency-key PARSE_INTENT --json`.
A large archive returns HTTP 202 with `kind: pending` and its decoding or
normalizing phase after each bounded step. Repeat the same command and key until
HTTP 201 returns the sealed Source Observation Set. Further retries return that
same set; a different key starts a separate interpretation of the retained bytes.

The [example plan](../examples/one-piece-two-source-plan.json) selects required
Bandai P-001 catalogue/event corroboration and Limitless P-001 evidence. Its
completeness is confined to those named source scopes, not the entire game.
Use only subsets declared by the installed registry. Set each source's `required`
or `optional` participation before starting; retry preserves the plan.

The [five-Card One Piece plan](../examples/one-piece-five-card-plan.json) extends
those complete scopes with ST01-001, OP16-002, OP16-019 and OP16-021. It selects
all linked Limitless variants and original fronts, the complete Bandai searches,
and the existing P-001 event corroboration. The retained
[evidence and image comparisons](../../acceptance/fixtures/real-sources/2026-09-15-limitless/README.md)
establish the same-name Leader, Counter, Event/Trigger and Stage differences.
Bandai retains all three Source Authority areas. Both adapters require explicit
owner admission or linking; the serial Luffy appearance needs its own reviewed
supplementary-only admission. These named scopes do not select the full Products
and Promos indexes or establish token/art Card coverage.

The [Limitless full-scope plan](../examples/one-piece-limitless-full-scope-plan.json)
selects the complete declared English Limitless coverage: the two retained
[index roots](../../acceptance/fixtures/real-sources/2026-09-15-limitless-index/README.md),
every Products and Promos bucket they list (including Prize Cards and Misc.
Promos, see the [bucket census](../../acceptance/fixtures/real-sources/2026-09-21-limitless-buckets/README.md)),
every linked card detail and `?v=N` variant page and every referenced English
front. Index roots and buckets are discovery roles that yield only Source
Requests; any card page parses into one observation through the same selectors
the pilot proved. A grid entry whose only front is the Japanese print is retained
as evidence without an English image request. The registration's finite capacity
is the dated census envelope (9,559). The plan is Limitless-only and supplementary:
Bandai keeps every authority area, each new Card or Printing remains an Entity
Proposal until the owner admits it, and a run without the selected card-facts
authority cannot prepare a One Piece candidate. The
[composed full-scope plan](../examples/one-piece-full-scope-plan.json) pairs
Bandai's complete discovery with the same Limitless roots in one Ingestion Run so
the whole-game candidate can reconcile; Bandai's requests count against its own
registered capacity. Acquire either scope in budgeted tranches:
size `max_dispatches` for the roots, buckets and the pages plus fronts you intend
to reach, let the run pause on `source_acquisition_budget_exhausted`, inspect the
receipt, then extend the budget and resume. Collection must reach every discovered
request before the scope can reconcile or publish; a paused tranche is retained
evidence, not coverage. The pilot subsets keep their own request identities.

The Pokémon [Card and Product plan](../examples/pokemon-card-product-plan.json)
checks the complete detailed treatment inventories of TCGdex Snorlax `svp-051`
and Charizard `base1-4`, plus the selected official Garchomp card and 151 Pokémon
Center Elite Trainer Box publications. The separate
[correction plan](../examples/pokemon-correction-plan.json) checks the exact
9 February 2022 Garchomp Sonic Slip article after that Card is published, together
with the same complete Card and Product scopes required by the selected authority. Retained
[scope and evidence](../../acceptance/fixtures/real-sources/2026-09-14-pokemon/README.md)
explain the three available scans, four missing treatment scans, overlapping
Product text and full-import gaps. These plans do not select the whole game.

The [declared-catalogue plan](../examples/pokemon-declared-catalogue-plan.json)
selects TCGdex's complete declared English coverage: the English Set inventory
and Pocket roots, every non-Pocket Set, every enumerated Card record and each
record image a Printing references. Qualified records admit automatically; each
finish variant shares its record's image, which must be retained before that
Printing can publish. Edition or stamp variants without a depicted group, records
without an image, failed image fetches, foil-pattern claims and records the
profile cannot map stay Entity Proposals with explicit gaps. The registration's
finite capacity is the dated census envelope (45,000). Hosts are paced at one
metadata request per second and two concurrent image requests at 500 ms. The
selected official publications are a separate supplement; run their plans
after the TCGdex Cards are published; how official Garchomp joins TCGdex `swsh9-109`
remains an open owner decision in [#329](https://github.com/KeeprDigital/card-keepr/issues/329).

The Riot [refresh plan](../examples/riftbound-riot-refresh-plan.json) selects
Riot's complete registered English scope: the first gallery page and every page
it links, one publisher front per returned record, and the errata and products
articles. The retained inventory has 1,189 returned records (1,197 declared) and an
estimated 1.1 GB of PNG fronts; 26 overnumbered or signature fronts are 1488x2078,
within the registration's 8 MiB body bound. Pacing keeps the gallery API and
`playriftbound.com` sequential at 1 s or slower and allows up to four fronts in
flight on `cmsassets.rgpub.io`. Each retained front lets its Printing qualify
automatically; a failed front is an explicit image gap, and a record whose front
was never retained stays an Entity Proposal. Fronts already retained at the same
URL are skipped. Budget one dispatch per page, article and front not yet
retained, plus retry headroom.

The Riftbound DB [pilot plan](../examples/riftbound-db-pilot-plan.json) selects only
the retained facet surface and first three results of each PR/Bird query, with four
inspected original images. Its seven-request bound is not a full PR inventory.
[Evidence and scope](../../acceptance/fixtures/real-sources/2026-09-14-riftbound-db/README.md)
record the access limits, duplicate Bird, unresolved promo identities, existing
Riot Eclipse Herald overlap and intended full-import gaps. Confirm the applicable
acquisition scope before using the networked plan; source selection alone does not
permit a full crawl. An owner may link the evidenced overlap, while the promo
records remain proposals until qualification supplies complete intake. Riot's
Source Authority is unchanged.

The Piltover Archive [pilot plan](../examples/piltover-archive-pilot-plan.json)
selects the first public gallery page and the front art of its two pinned rows
under a three-request capacity. [Evidence and scope](../../acceptance/fixtures/real-sources/2026-09-21-piltover-archive/README.md)
record the budgeted acquisition, the Blazing Scorcher overlap that an owner may
link, and the Vi ARC-001 lead whose retained front is a Chinese-language print
and therefore stays an unresolved proposal. Other gallery rows are retained bytes
only; the plan establishes neither the gallery inventory nor promo coverage.
The [census plan](../examples/piltover-archive-census-plan.json) selects the
`gallery-census` scope: `/cards?page=1`, every page it reports and the front of
every row on the two registered art hosts, under a 1,400-request capacity (26
pages and 1,240 rows on 2026-09-21, plus headroom). A later page whose page count,
displayed total or page size differs from page 1 fails the parse; retry the run
rather than resuming a changed gallery. Every row becomes a source-record Entity
Proposal for owner review; the census does not qualify issuance or English print.

The HexDeck [pilot plan](../examples/hexdeck-pilot-plan.json) selects pages 1
and 7 of the Images-format search sorted by Set under a four-request capacity,
with the pinned Blazing Scorcher listing and the OGN T01 Buff token and their
page-referenced fronts. [Evidence and scope](../../acceptance/fixtures/real-sources/2026-09-21-hexdeck/README.md)
record the three budgeted runs, the rejected bare image locator, and why both
records stay unresolved review records: the listing surface has no rules text,
artist, finish or locale, and the search query parameter is not exposed.
The [census plan](../examples/hexdeck-census-plan.json) selects the
`search-census` scope: page 1 of the same search in HexDeck's own link order,
every page its total implies and each listing's page-referenced front, under a
1,100-request capacity (19 pages and 940 listings on 2026-09-21, plus headroom).
A page that drifts from page 1 or lacks its implied row count fails the parse;
retry rather than resume. Every listing becomes a source-record Entity Proposal
that cannot be linked from this surface.

Independently complete named scopes can be collected and published successively.
Keep each scope's exact root contract and complete Card variant inventory; a
page slice is valid only when its adapter establishes that inventory. Prepare the
next whole-game candidate against the last published game revision and wait for
its verified backup before advancing. Inspect unchanged entities and their
retained evidence as well as the newly checked scope; publication does not make
unselected evidence fresh. Arbitrary page ranges and new Source Lineages are not
substitutes for a registered scope. The synthetic bounded arrangement and its
accounting pilot are selected separately under [testing](../testing.md).

Source registration and network access do not designate fact authority. Inspect
the current generation before an explicit scoped change:

```sh
keepr source designate --game one-piece --locale en --release-region OCEANIA \
  --area card_facts --source-lineage limitless-one-piece-en \
  --expected-generation 0 --rationale 'Reason for this source selection' \
  --idempotency-key AUTHORITY_INTENT --json
```

Other areas are `printing_details` and `corrected_card_content`. Authority changes
require idle collection/publication/recovery/release operations. A missing selected
authority cannot silently fall back to another source. Optional availability
outages can carry accepted facts forward with warnings; required capture failures,
identity uncertainty and contradictory evidence still block the refresh.

Riot starts with all three areas for its registered English/US scope. An existing
explicit owner designation remains selected. Scryfall starts with all three in
its English/unknown-region Magic scope. Pokémon's English/unknown-region scope
starts with TCGdex for card facts and Printing details and selected official
publications for corrected card content. The [Scryfall pilot plan](../examples/scryfall-magic-pilot-plan.json)
selects four issued English paper records and their declared finishes/faces.
Its [retained evidence and limitations](../../acceptance/fixtures/real-sources/2026-09-14-scryfall/README.md)
define acquisition bounds, qualification and the remaining full-import scope.

The [Scryfall bulk plan](../examples/scryfall-magic-bulk-plan.json) selects the
default complete Source Coverage. Its single metadata root pins one dated
`default_cards` gzip JSONL archive and its advertised compressed length. Collection
derives current normal JPEG requests from issued English, paper, nondigital
records through the archive's date, excluding incidental deck indicators. The
named four-card pilot remains separate and keeps its existing request identities.
The registration's finite capacity uses the retained dated image-location census;
it does not establish full-import throughput, image bytes, publication or recovery.
Inspect any capacity pause before choosing an extension. The remaining full-scope
evidence is tracked in [#327](https://github.com/KeeprDigital/card-keepr/issues/327).

The [Scryfall facts plan](../examples/scryfall-magic-facts-plan.json) is the
first Magic import (tranche 0). Its `facts-only` scope reads the same root and
archive but admits no image request, so the run needs only the metadata and
archive dispatches and each Printing publishes with an explicit image gap.

Later image tranches use the [image tranche plan](../examples/scryfall-magic-images-tranche-plan.json)
under an owner-approved budget. Its `image-tranche` scope reads the same root and
archive; `discovery_selection` lists the set codes to acquire (newest first) and
caps the tranche with `maximum_requests`. Build the next tranche by editing the
set list; the plan is immutable once a run starts. Every unselected image request
is deferred, never fetched: `source show` prints `Deferred: N discovered requests`
with the largest groups, and the JSON `collection.deferred_requests` has exact
counts. Publish each tranche before starting the next. Images published earlier
stay on their Printings, and re-selected ones are skipped unchanged with no
dispatch. Budget one dispatch per newly selected image plus the two root
dispatches and retry headroom; see
[paused collection](#paused-or-failed-collection) for extensions.

`source show` reports coverage, request counts, successful check time and actual
content capture time. A partial check never advances successful freshness. A
complete named check can report a Printing no longer observed without deleting it.
An omitted/optional-unavailable scope makes no absence claim.

Use `source lifecycle --lineage LINEAGE` to inspect lifecycle. Retirement or
reactivation uses `source set-lifecycle --lineage LINEAGE --state retired|active
--expected-generation N --rationale TEXT --idempotency-key KEY`. Retirement requires
idle operations and prior revision of affected authority designations; it retains
accepted entities/history and blocks new collection/retry. It is not withdrawal.

## Paused or failed collection

Inspect `actions`, `collection.pause_reason`, per-source capacity/generation,
request and evidence counts, failed images, and Workflow Attempts. Counts are
exact; detail lists may be truncated. A pause keeps retained evidence and the
same run; collection must complete before reconciliation/publication.

| Pause reason                                                                                           | Response                                                   |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `source_request_capacity_exhausted`                                                                    | Extend to the required absolute capacity, then resume      |
| `source_transport_retries_exhausted`                                                                   | Resume after the source recovers                           |
| `source_storage_retries_exhausted`                                                                     | Resume after R2 recovers, including image storage failures |
| `source_workflow_stalled`, `errored`, `terminated` or `unavailable` with the `source_workflow_` prefix | Resume through owner administration                        |
| `owner_requested`                                                                                      | Resume or terminate                                        |

```sh
keepr source capacity extend --run-id RUN \
  --expected-capacity CURRENT --expected-generation GENERATION \
  --capacity NEW_ABSOLUTE_CAPACITY --idempotency-key EXTEND_INTENT --json
keepr source resume --run-id RUN --json
```

Capacity must increase and remain below the global emergency ceiling. Extension
does not resume work. Resume continues retained requests under a new Workflow
Attempt and bounded retry generation; it never renews completed capture work.
If `collection_workflow_supersession_pending` reports a live or unreadable prior
attempt, keep the run paused and retry the same resume after the control plane
recovers. Pacing and Retry-After waits are not stalls.

For `source_acquisition_budget_exhausted`, inspect the limiting `dimension` and
`acquisition.unsettled` entries. An entry whose `workflow_instance_id` has
positively finished settles on resume once its object is absent and its attempt
is recorded as failed; a live or unreadable owner keeps
`source_acquisition_ownership_pending`. Save the exact current `acquisition.budget` to
`CURRENT_BUDGET.json`; choose larger limits or a later deadline in `NEW_BUDGET.json`.

```sh
keepr source budget extend --run-id RUN --expected-generation GENERATION \
  --expected-budget-file CURRENT_BUDGET.json --budget-file NEW_BUDGET.json \
  --idempotency-key EXTEND_BUDGET_INTENT --json
keepr source resume --run-id RUN --json
```

Extension decreases no limit, changes at least one, retains all charges, and
leaves the run paused. A remaining limit or unresolved physical owner can still
block resume. Cleanup does not restore spent allowance. Do not replace uncertain
exposure with zero based on a timeout, missing object, or superseded Workflow.

An unfinished legacy run may show `acquisition: null`. For an unstarted or paused
run with settled earlier ownership, use the same budget command with
`--expected-generation 0` and an expected-budget file containing JSON `null`.
Initialization verifies retained raw objects and charges each physical key once
as a byte baseline. Earlier dispatch totals remain unknown. It leaves work
unstarted or paused; run `source resume` separately. Ambiguous older work or
unreadable Workflow/storage evidence blocks initialization. Completed or terminal
history stays inspectable without inventing accounting.

Stop a collecting run through its lifecycle, rather than terminating provider
instances directly:

```sh
keepr source pause --run-id RUN --idempotency-key PAUSE_INTENT --json
keepr source terminate --run-id RUN --idempotency-key TERMINATE_INTENT --json
```

Termination preserves evidence, fences late work and releases its reservation.
A terminated/failed run cannot resume; `source retry --run-id RUN
--budget-file OWNER_SELECTED_BUDGET.json --idempotency-key NEW_INTENT` creates a linked run. Integrity failures such as
malformed discovery, identity collision and contradictory required surfaces are
terminal rather than retry pauses.

Image transport failures retain an explicit gap and permit collection to continue.
`collection.failed_images` names unavailable/rejected/redirected/body-invalid
requests; candidates carry `printing_image_unavailable`. They publish without
those images. Collect again after recovery. Storage retry exhaustion still pauses
the run. Redirects are never followed as if they were the original evidence.

A listing, detail or product-detail request answered by a 301/302/303/307/308
whose HTTPS `Location` is on the same registrable domain keeps that redirect
response as its retained evidence and ends as `source_request_redirect_discovered`.
The resolved Location is enqueued once as a new Source Request with the same role,
discovered from the redirected request, and charged to the Acquisition Budget like
any dispatch. One hop only: a redirect from a redirect-discovered request, a
cross-site or non-HTTPS target, a root surface, a Printing Image, and adapters
that read retained parent context still fail as `source_redirect_rejected` (or the
tolerated image gap).

## Resolve an uncertain existing identity

```sh
keepr identity inspect --identity-id PRINTING --json
keepr identity reviews --run-id RUN --json
keepr identity reviews --preparation-id CANDIDATE --json
keepr identity resolve --review-id REVIEW --printing-id PRINTING \
  --rationale 'Evidence establishing this issued Printing' \
  --idempotency-key IDENTITY_INTENT --yes --json
```

Follow `next_cursor` with `--after`. Inspect candidate mappings and retained
images before selecting an eligible existing identity. Matching names, rules,
image bytes or changed URLs alone do not prove the same Printing. The decision
cannot create an entity, merge published IDs or override contradictory facts.
Resolve with mutation idle, then retry the blocked collection. Decisions retain
the exact semantic evidence and do not approve publication.

## Admit missing real entities

Qualified, sufficiently evidenced authoritative observations can enter a candidate
automatically. For Riot, matching publisher Printing code, locator, set and
collector number plus retained front-image proof establish eligible intake;
unknown finish, back and original printed wording remain unknown. For Scryfall,
the exact record, finish and illustration identity qualify a Printing without
image bytes; it publishes with an explicit image gap. An unqualified
adapter, insufficient identity or supplementary-only discovery retains an Entity
Proposal for explicit owner review. Existing admission decisions are reused after
refresh and recovery, including when a new image request fails. Inspect those
image gaps and all candidate exclusions before whole-candidate approval.

```sh
keepr entity-proposal create --proposal proposal.json --yes --json
keepr entity-proposal list --game one-piece --json
keepr entity-proposal inspect --proposal-id PROPOSAL --json
keepr entity-proposal evidence --proposal-id PROPOSAL --json
keepr entity-proposal admit --proposal-id PROPOSAL --decision decision.json --yes --json
```

The proposal contains `game`, `source_lineage` (`owner` for personal intake),
stable source `reference`, `content`, `evidence` and `idempotency_key`. Use normalized
Card and optional Printing shapes without canonical IDs. HTTP command bodies are
limited to 16 KiB; the separate retained-intake domain bound is 64 KiB. Unknown
numbers use `{"kind":"unknown","value":null}`. Personal evidence records specific
observations in `evidence.attestation`; retained captures reference their real
snapshot/observation identities.

Decisions contain decimal-string `expected_generation`, `rationale` and
`idempotency_key`. `admit`, `link`, `reject` and `reconsider` share the command
shape. Linking names an existing `card_id` or `printing_id`; a new Printing can
be admitted under an existing `card_id`. Known numbered Cards cannot be duplicated.
An exception adds `exception.scope` (only needed `source_evidence`/`identity`
scopes) and a specific `exception.attestation`; it cannot waive game structure or
an identified Card. Required evidence contradictions block publication.

Reconsideration can append content/evidence but never rewrites initial intake,
rejection history or allocated IDs. Inspection history uses `--after-generation`;
lists use `--after`. Changed keys/generations conflict. Unresolved proposals may
be excluded with warnings if remaining relationships are consistent.

Admission affects a fresh reconciliation. If an older sealed candidate holds the
game slot, retain its inspection then use `game-candidate abandon --candidate-id
CANDIDATE --generation N --idempotency-key KEY --yes` before preparing again.
A retained source fixture or a visual finding never silently installs an owner
attestation. The [real-source pack](../../acceptance/fixtures/real-sources/2026-09-06/README.md)
describes the bounded P-001 evidence and its limits.

## Correct published identities or facts

For a merge/split, first admit and publish any replacement entities. Create a JSON
proposal with `game`, `entity_kind`, `action`, `source_ids`, `replacement_ids`,
`printing_assignments`, `expected_current_revision_id`, `rationale` and
`evidence.attestation`. A merge has one survivor. A split has one source and at
least two replacements; a Card split assigns every affected Printing explicitly.

```sh
keepr identity-correction validate --proposal correction.json --json
# Add the returned review_digest and a fresh idempotency_key to the proposal.
keepr identity-correction create --proposal correction.json --yes --json
keepr identity-correction inspect --correction-id CORRECTION --json
keepr identity-correction list --game GAME --json
```

Validation binds current entities, relationships and preceding decisions. A changed
revision needs revalidation. One review permits 100 IDs per side, 1,000 Printing
relationships and 256 KiB retained review. HTTP commands remain capped at 16 KiB
within the 64 KiB domain proposal bound. A later Printing under a
split Card remains excluded until an `assign` decision maps its ID to an existing
replacement; at most 100 assignments per such decision. Consumer-owned copies
are never assigned automatically.

Reconcile and approve a new candidate to publish the decision. Old revisions stay
unchanged. Retired identity reads expose a survivor or all split replacements;
consumers must choose at an ambiguous split. Corrections never reactivate an old
identity silently.

Use `curated-revision validate` then `create` for exceptional existing facts,
with the exact proposal digest and current revision. `reaffirm`, `supersede` and
`retire` are explicit lifecycle actions; a changed overridden source field needs
reconfirmation. See the [administration contract](../../contracts/ADMINISTRATION.md)
for confirmation flags and request shapes. Identity correction and Curated
Revision decisions remain separate from whole-candidate publication.
