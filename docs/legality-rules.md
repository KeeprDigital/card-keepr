# Legality Rules and contextual status

Legality is published as effective-dated `Legality Rule` records. A
`Legality Status` is never stored: the API derives it for an explicit `Card`,
date, region, format, and optional event tier from the current
`Catalogue Revision`.

## Source adapter input

The following production Catalogue adapters are installed for bounded,
credential-free capture of their exact Official Source surfaces and dynamic
request graphs:

- `one-piece-en@2`
- `fusion-world-en@3`
- `digimon-en@3`
- `gundam-en-asia@3`
- `gundam-en-us@3`

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

The earlier production versions (`one-piece-en@1`, `fusion-world-en@2`,
`digimon-en@2`, and both Gundam `@2` versions) remain registered with their
original parser contracts. Reprocessing retained bytes through one of those
identities cannot gain Legality Rule observations; a non-empty legality
sidecar still fails closed. Synthetic fixture adapters follow the same
append-only rule: One Piece `@3` and the other games' `@2` versions are the
legality-aware identities, while prior fixture versions retain their original
behavior.

An Ingestion Run retains one canonical immutable Evidence Plan wrapper with a
separate plan for every selected Source Lineage. Static root requests and every
dynamically discovered child request are immutable and provenance-bound to
their owning plan and parent request. Reconciliation validates completeness,
lifecycle, and freshness independently for each lineage; it never assigns a
combined run to the first plan's lineage.

The required legality scope is discovery, legality Card details, current
Legality Rules, and Legality history. The One Piece adapter additionally
requires block-policy, release-timing, and DON-rule surfaces. A surface may be
split across multiple uniquely identified URLs. This contract does not claim
complete Product, general Card catalogue, or Errata coverage. Planning rejects
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

Legality Card details and notices are parsed by the game-specific adapter from
raw Official Source fields. Card identity is established only from those
details; nested Printing Image URLs must remain within the adapter's exact
Official Source origin and locale path. Redirects or foreign image authorities
cannot establish identity. Legality notice wording must express the declared
normalized action; unknown or contradictory wording fails closed instead of
being guessed into an effect.

Each rule retains its Official Source identity as `official_id`, exact wording,
game, region, format, nullable event tier, effective interval, affected Card
Numbers, normalized effect, and `representable: true`. Its catalogue `id` is
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
Every result includes the applicable Legality Rule IDs and an auditable
derivation. `Catalogue Export` component `legality-rules` contains the
external rule records, with `legality-rule-card` relationships in the
`relationships` component. Newly generated exports use schema major 2 and
retain `official_id`, source lineage and observation IDs, lifecycle, and each
rule's complete normalized `effect`, including every operand and unresolved
reason. Lifecycle on the rule itself states whether it is current and
preserves its observation boundaries, including for globally applicable rules
whose `card_ids` array is empty. Card-scoped relationships remain supplemental.
Historical schema-major-1 artifacts remain immutable and readable.

Migration `0008_legality_rules.sql` adds canonical provenance retention and
the revision-scoped rule snapshot used by the API. Apply it before deploying
either Worker.
