# Legality Rules and contextual status

Legality is published as effective-dated `Legality Rule` records. A
`Legality Status` is never stored: the API derives it for an explicit `Card`,
date, region, format, and optional event tier from the current
`Catalogue Revision`.

## Source adapter input

The following production Catalogue adapters are installed for bounded,
credential-free capture of their exact Official Source surfaces and dynamic
request graphs:

- `one-piece-en@6`
- `fusion-world-en@9`
- `digimon-en@7`
- `gundam-en-asia@7`
- `gundam-en-us@7`

The issue-58 generation (`one-piece-en@6`, `gundam-en-asia@7`,
`gundam-en-us@7`) closes the two remaining production fail-closed walls
without losing precision. The Gundam adapters pin their `legality` surface to
the live `news/01_279.html` publication and parse the 2026-07-24 compound
policy exactly: one ban, one two-copy restriction, and two explicit banned
pairs each retain an unresolved effective interval, and the open-predicate
group ("a Unit card that is Lv.2 with cost 1, 2 AP, and 2 HP, and without
effects", future printings included) becomes one explicit `unresolved` rule
whose `unresolved_scope.dimensions` name both `effective_interval` and
`target_scope` while retaining the twenty enumerated matching Cards. The One
Piece adapter's `don-rules` surface accepts the live `/rules/` hub as exact
coverage evidence without DON!! payload facts: the hub's identity and its
pinned restriction, block-policy, and errata links are verified and retained
explicitly, the surface emits a structurally complete empty Legality Rule
observation, and no comprehensive DON!! Printing claim is made — absence
never proves zero Printings, and the DON!! reconciliation warning stays
explicit whenever DON!! evidence is present. Earlier versions keep their
original fail-closed behavior for retained replay.

The optional-card-field generation (`fusion-world-en@7`, `digimon-en@7`)
models the remaining live card-detail vocabulary: Fusion World Energy
Marker details publish no rarity block (their rarity is explicitly null;
every other Card type still requires its exact rarity), and Digimon Q&A
answers may nest related-card lists that are retained as explicit
related-card evidence alongside the Appmon crossover digivolution and
Link DP bonus vocabulary.

The fusion live-shape generation (`fusion-world-en@9`) models the five live
page shapes retained by the third full-scale production run, including the
pinned legality-history restriction lift, and declares the issue-63 request
capacity sized for the legitimate production Fusion World request graph.
`one-piece-en@6` declares the request capacity sized for the first
production One Piece run of 2026-09-03 (#134).

These registrations establish request, byte, parser, graph, and surface
coverage contracts; they do not authorize a shared normalized JSON envelope.
Each immutable Source Snapshot must contain exactly one demonstrated publisher
response. Production adapters
must not accept a shared normalized envelope or a test fixture representation.
Raw inputs must not supply a normalized rarity, identity digest, structured
effect, or `representable` decision; the owning adapter must derive those
values from demonstrated publisher fields and fail closed when it cannot.
The legality-aware versions normalize only source-specific publisher fields
whose action and wording can be represented exactly. Reconciliation rejects a
non-empty rule-bearing surface unless its same retained request also emits an
explicitly complete `legality_rules` observation. Unknown action codes,
contradictory wording, and free-form notices without the exact versioned field
contract fail closed. A structurally proven empty legality surface may
establish complete empty coverage.

`one-piece-en@6`, `digimon-en@7`, and the Gundam `@7` versions explicitly
own both Catalogue and standalone Official Errata reconciliation areas. A
successful run records freshness independently for `cards-and-printings`
and `errata`; neither area is inferred from the adapter version string. The
reconciliation areas are registration data declared beside each version on
its lineage contract. `fusion-world-en@9` owns Catalogue coverage only: the
live Fusion World EN site no longer publishes a Card Errata surface (its
former `/fw/en/rules/errata-card/` URL returns 404).

Every registered production version reads the live product detail pages:
every game now publishes its product identity through the document title
(the leading `h1` is the site logo), official codes are demonstrated as
bracketed title suffixes, and the listings sweep accessory publications.
Card-associated publications are promoted to Products; accessory pages
(sleeves, card cases, playmats) are fetched and retained as explicit
`non-card:accessory` distribution-context evidence instead of being skipped
by URL vocabulary or promoted to Products.

Before Go-Live (ADR 0008) each Source Lineage keeps exactly one Source
Adapter Version, edited in place: `one-piece-en@6`, `fusion-world-en@9`,
`digimon-en@7`, `gundam-en-asia@7`, and `gundam-en-us@7`. No predecessor is
parseable and no retired registration exists; #135 removed the predecessor
versions and the 22 retired registrations, the retirement runbook, and the
retired-runs query. A Source Snapshot is reparsed only by its exact
capturing version, and an unregistered version is refused with
`adapter_not_supported`. From Go-Live, ADR 0004 applies: parser
implementation is retained for the active version and its immediate
predecessor, older versions are retired with their registration kept, and
reparsing retained Source Snapshots is done by registering a new version.

An Ingestion Run retains one canonical immutable Evidence Plan wrapper with a
separate plan for every selected Source Lineage. Each complete production plan
contains exactly one discovery request. Parsing that retained discovery
evidence creates a separately immutable Official Source Collection Plan for
the exact bounded surface requests; later dynamically discovered child
requests remain immutable and provenance-bound to their parent request.
Reconciliation verifies all three artifacts and validates completeness,
lifecycle, and freshness independently for each lineage; it never assigns a
combined run to the first plan's lineage.

The required legality scope is discovery, legality Card details, current
Legality Rules, and Legality history. The One Piece adapter additionally
requires every Recording leaf, Product, Release, block-policy, release-timing,
DON-rule, and Errata surface. Its `@3` contract claims complete One Piece Card,
Printing, Product, Release, Legality Rule, and Errata coverage while making no
comprehensive DON!! Printing claim. Other game adapters retain their narrower
legality-oriented coverage. A surface may be split across multiple uniquely
identified URLs. Planning rejects
origins and locale paths outside the adapter's Official Source authority. Live
discovery must enumerate the request identity, surface name, and exact URL of
every collection request, and reconciliation verifies that graph against the
separately retained snapshots. Each surface declares the adapter's exact
regional partition and total record count alongside the source-specific raw
record collection. A truly empty Legality Rule or legality Card-detail surface
may be represented by a declared total of zero and an empty collection.
Every non-empty rule-bearing surface must retain at least one structurally
valid, exactly parsed rule; a retained raw sidecar alone is not a rule parser.
The adapter and reconciliation boundary derive completeness from this
structure and reject missing
surfaces, mismatched counts, unexpected partitions, cross-game envelopes, and
unknown publisher fields. Current rules, historical notices, and every One
Piece policy stream are all rule-bearing: their wording must normalize into a
Legality Rule or the run fails.

When a publisher uses the same URL and byte-identical rule representation for
current and history request identities, reconciliation keeps one deterministic
rule observation. The two observations must agree on every identity-bound
semantic field; a disagreement fails the run. Conditional prose such as
"unless", "except", or "only if" also fails closed unless the adapter version
has an explicit structured effect capable of retaining the condition.

Legality Card details and notices are parsed by the game-specific adapter from
raw Official Source fields. Card identity is established only from those
details; nested Printing Image URLs must remain within the adapter's exact
Official Source origin and locale path. Redirects or foreign image authorities
cannot establish identity. Legality notice wording must express the declared
normalized action; unknown or contradictory wording fails closed instead of
being guessed into an effect.

Each rule retains its Official Source identity as `official_id`, exact wording,
game, region, format, nullable event tier, effective interval, affected Card
Numbers, normalized effect, and `representable: true`. If the publisher omits
an effective boundary or event tier that cannot be inferred, the adapter emits
an `unresolved` effect with `unresolved_scope.dimensions` naming
`effective_interval`, `event_tier`, or both. If the publisher targets an open
predicate whose membership extends beyond the enumerated Cards (including
future printings), the issue-58 adapter generation adds the `target_scope`
dimension: the rule still retains the enumerated known matches as explicit
Cards, and the dimension declares the remainder of the scope unresolved.
Such a rule must target explicit
Cards: it cannot invent an effective date or compile the open predicate into
invented pairs. A `target_scope` rule additionally materializes one explicit
`all_cards` applicability row, so every contextual status query in its game,
region, and format retains the uncertainty; rules without that dimension
cannot become global. Its catalogue `id` is
derived from the canonical pair of `source_lineage` and `official_id`. Once
that identity is observed, identity-bound rule semantics cannot change; the
Official Source must publish a new official identity for a semantic change.

Supported effects are `eligible`, `ban`, `copy_limit`,
`prohibited_combination`, `membership`, `rotation`, `release_timing`, and
`unresolved`. Unknown fields or effects, invalid intervals, conflicting
regions, missing Cards, duplicate rule identities, and
unrepresentable raw publisher action codes block the selected Ingestion Run
before approval.
A complete observation replaces only its own source lineage. Rules missing
from that observation remain in catalogue history as non-current, with their
first-observed, last-observed, and last-missing revisions. Reappearance of the
same unchanged official identity restores it as current while retaining that
lifecycle history.

Gundam `EN-ASIA` and `EN-US` are separate source lineages. Do not ingest or
derive an `EN-OCEANIA` Gundam scope. Rule applicability is determined only by
the published effective interval and requested context; fetch order and
capture recency never establish authority.

Approval rechecks every status-changing date against the approval clock,
including `effective_from`, `effective_until`, and
`release_timing.legal_from`, for current and retained non-current rules alike.
A candidate whose status could have changed since reconciliation must be
reconciled again.

Legality freshness is published independently for each exact Source Lineage
and region. Every `legality-rules` entry in `GET /v1/catalogue`, administration
status, and export manifest v3 includes `source_lineage` and `region`; other
freshness areas omit both fields. A partial Gundam refresh advances only its
own `EN-ASIA` or `EN-US` check and preserves the other lineage's last
successful timestamp. Historical export manifest v1 artifacts retain their
original unscoped freshness representation.

## Consumer query

Use authenticated `GET /v1/legality-status` or:

```sh
keepr legality status \
  --card-id CARD_ID \
  --on 2026-07-30 \
  --format standard \
  --event-tier championship \
  --region EN-ASIA \
  --json
```

Omitting `--region` returns every supported regional result separately,
including an `indeterminate` result where no effective published rule exists.
Every result includes effective rules in `rule_ids`, contextual uncertainties
in `unresolved_scope_rule_ids`, and an auditable derivation. A scoped
uncertainty yields `indeterminate` when no definitive rule decides the result;
definitive exclusions still take precedence while retaining the uncertainty
in the audit. `Catalogue Export` component `legality-rules` contains the
external rule records, with `legality-rule-card` relationships in the
`relationships` component. Newly generated exports use schema major 5, the
`card-keepr-catalogue-export-manifest@5` format, the canonical
`https://card-keepr.invalid/schemas/catalogue-export-manifest@5` manifest
schema URI, and component schema URIs rooted at
`https://card-keepr.invalid/schemas/catalogue-export-record@5` with the exact
record `$defs` fragment (see ADR 0003: major 5 admits the `target_scope`
unresolved dimension). They retain `official_id`, source lineage and
observation IDs, lifecycle, and each rule's complete normalized `effect`,
including every operand and unresolved reason, plus nullable `effective_from`
and explicit `unresolved_scope`.
Lifecycle on the rule itself states whether it is current and
preserves its observation boundaries, including for globally applicable rules
whose `card_ids` array is empty. Card-scoped relationships remain supplemental.
Historical schema-major-1 through schema-major-4 artifacts remain
byte-identical, immutable, and readable through their explicitly versioned
schemas; retained major-3 and major-4 exports continue to use their recorded
manifest and record URIs.

Each revision materializes indexed applicability for every Card-scoped rule
and one explicit `all_cards` row for a genuinely global rule or for a rule
whose unresolved scope names `target_scope`. The authenticated
status query selects only the requested Card plus those global rows and applies
the requested region before loading stored rule documents. Publication and one
status result are bounded to 16,384 applicability rows; exceeding that bound
fails closed instead of scanning or allocating an unbounded result.

The schema baseline (`migrations/0001_baseline.sql`, ADR 0006) registers
every Source Adapter Version generation: the complete One Piece, Fusion
World, Digimon, and Gundam adapters, the 2026-08 site-restructure
generation, the live product-detail generation, the issue-58 generation
with the `target_scope` unresolved-scope dimension and its `all_cards`
applicability, and the optional-card-field generation. A new generation is
registered by a later migration. Apply every migration before deploying
either Worker.
