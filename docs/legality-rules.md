# Legality Rules and contextual status

Legality is published as effective-dated `Legality Rule` records. A
`Legality Status` is never stored: the API derives it for an explicit `Card`,
date, region, format, and optional event tier from the current
`Catalogue Revision`.

## Source adapter input

The following production Catalogue adapters are installed for bounded,
credential-free capture of their exact Official Source surfaces and dynamic
request graphs:

- `one-piece-en@3`
- `fusion-world-en@4`
- `digimon-en@4`
- `gundam-en-asia@4`
- `gundam-en-us@4`

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

`digimon-en@4` explicitly owns both Catalogue and standalone Official Errata
reconciliation areas. A successful run records freshness independently for
`cards-and-printings` and `errata`; neither area is inferred from the adapter
version string.

The earlier production versions (`one-piece-en@1`, `one-piece-en@2`,
`fusion-world-en@2`, `fusion-world-en@3`,
`digimon-en@2`, `digimon-en@3`, and both Gundam `@2` and `@3` versions) remain
registered with their original parser contracts only for explicit reprocessing
of retained Source Snapshots. New production Evidence Plans accept only the
active registrations listed above. Reprocessing retained bytes through an
earlier identity cannot gain Legality Rule observations; a non-empty legality
sidecar still fails closed. Synthetic fixture adapters follow the same
append-only rule: One Piece `@3` and the other games' `@2` versions are the
legality-aware identities, while prior fixture versions retain their original
behavior.

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
`effective_interval`, `event_tier`, or both. Such a rule must target explicit
Cards: it cannot become a global rule, invent an effective date, or claim an
unbounded scope. Its catalogue `id` is
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
`relationships` component. Newly generated exports use schema major 3 and
retain `official_id`, source lineage and observation IDs, lifecycle, and each
rule's complete normalized `effect`, including every operand and unresolved
reason, plus nullable `effective_from` and explicit `unresolved_scope`.
Lifecycle on the rule itself states whether it is current and
preserves its observation boundaries, including for globally applicable rules
whose `card_ids` array is empty. Card-scoped relationships remain supplemental.
Historical schema-major-1 and schema-major-2 artifacts remain byte-identical,
immutable, and readable through their explicitly versioned schemas.

Each revision materializes indexed applicability for every Card-scoped rule
and one explicit `all_cards` row for a genuinely global rule. The authenticated
status query selects only the requested Card plus those global rows and applies
the requested region before loading stored rule documents. Publication and one
status result are bounded to 16,384 applicability rows; exceeding that bound
fails closed instead of scanning or allocating an unbounded result.

Migrations `0009_one_piece_complete_catalogue.sql`,
`0010_fusion_world_complete_catalogue.sql`, and
`0011_digimon_complete_catalogue.sql` register the complete One Piece, Fusion
World, and Digimon adapters after `0008_legality_rules.sql`. Apply all four
before deploying either Worker.
