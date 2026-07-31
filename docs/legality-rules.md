# Legality Rules and contextual status

Legality is published as effective-dated `Legality Rule` records. A
`Legality Status` is never stored: the API derives it for an explicit `Card`,
date, region, format, and optional event tier from the current
`Catalogue Revision`.

## Source adapter input

No publisher-specific legality adapter is currently installed. The following
adapter identities are intentionally unavailable until their publisher
representations, image-byte capture, redirect policy, and structured notice
operands are verified against retained first-party evidence:

- `one-piece-json-document@3`
- `fusion-world-en@2`
- `digimon-en@2`
- `gundam-en-asia@2`
- `gundam-en-us@2`

Production planning fails closed with `adapter_not_supported` for all five
identities. They are reserved documentation names, not installed adapter
contracts and not permission to accept synthetic JSON as a publisher response.

When a publisher-specific adapter is installed, each immutable Source Snapshot
must contain exactly one demonstrated publisher response. Production adapters
must not accept a shared normalized envelope or a test fixture representation.
Raw inputs must not supply a normalized rarity, identity digest, structured
effect, or `representable` decision; the owning adapter must derive those
values from demonstrated publisher fields and fail closed when it cannot.
The remaining source-adapter requirements in this section describe that future
installation contract; they do not claim that a publisher representation is
currently supported.
An Ingestion Run begins with an immutable one-request Discovery Plan. The
retained discovery observation creates, once, a separately named Official
Source Collection Plan containing the exact bounded set of discovered
requests. That collection plan is immutable, bound to the discovery
observation by identity, and bound to its canonical JSON by SHA-256; retries
must reproduce it byte-for-byte. The original Discovery Plan is never expanded
or rewritten.

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
Discovery, history, and the One Piece policy surfaces must each retain at
least one structurally valid record.
The adapter derives completeness from this structure and rejects missing
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
