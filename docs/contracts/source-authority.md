# Shared Game Profiles and Source Authority

The authenticated ingestion API exposes `GET /v1/source-registry`. Publisher
ownership, Source identity, regional English Source Lineages, shared typed Game
Profiles, and installed adapter bindings are separate registrations. Source
registration does not install a parser or grant network permission. The declared
Limitless One Piece Source has no shipped adapter; concrete acquisition follows
in a separate ticket. Registered games remain the existing four Bandai games.

`GET /v1/source-authorities` returns the current designation for each game,
English locale, release region and card-content area. Initial publisher sources
are generation zero. These defaults are explicit in the registration policy;
new sources never replace an existing selection. Areas are `card_facts`,
`printing_details`, and `corrected_card_content`. Ownership and transport access
never grant fact authority, and supplemental designation never creates a
publisher-issued Erratum or publisher confirmation.

`POST /v1/source-authorities` accepts exactly these fields:

```json
{
  "game": "one-piece",
  "locale": "en",
  "release_region": "OCEANIA",
  "area": "card_facts",
  "source_lineage": "limitless-one-piece-en",
  "expected_generation": "0",
  "rationale": "Owner selected this source for the declared scope",
  "idempotency_key": "one-piece-card-authority-selection"
}
```

The generation is a non-negative decimal string. Success returns the decision
and its incremented numeric generation. An exact retry returns the original
decision; reusing a key for different intent or a stale generation returns 409.
Unregistered or mismatched source/game/locale/region/area returns 422. Authority
changes are fenced atomically while collection, review/publication, recovery or
a live production release owns the current operation. Decisions are append-only
administrative database records preserved by database backup; they do not enter
consumer projections or exports.

Acquisition can still retain non-authoritative evidence. Reconciliation rejects
a refresh whose applicable selected authority is missing, preserving captures
without silently substituting another source. Cross-source canonical matching,
entity admission, contradiction resolution and source-scoped carry-forward are
subsequent slices; this endpoint does not implement those policies or claim that
a supplemental-only partial refresh is a complete game catalogue.

The equivalent CLI commands are:

```sh
keepr source registry --json
keepr source authorities --json
keepr source designate --game one-piece --locale en --release-region OCEANIA \
  --area card_facts --source-lineage limitless-one-piece-en \
  --expected-generation 0 --rationale 'Owner-selected source' \
  --idempotency-key one-piece-card-authority-selection --json
```

Before Go-Live, edit the single profile and each active adapter definition in
place, retaining their existing identifiers. From Go-Live, register immutable
versions so retained interpretations remain attributable. A parser correction
uses fresh collection and ordinary candidate review; this slice promises no
cross-version reparse. Existing same-version snapshot operations remain.

Unknown optional Digimon HTML labels retain their original values in Source
Observations and produce actionable profile-review warnings. Required title,
identity and structural checks still fail closed. No unfamiliar mechanic is
invented in the consumer Game Profile.

`acceptance/shared-game-profiles.test.mjs` publishes separate representative
nested and tabular synthetic catalogues through owner CLI and authenticated
consumer API, proves shared typed fields and unknown-field warnings, and rejects
publisher fallback after supplemental authority selection. Its adapters,
transport and backup harness are test-only: it is not real Limitless coverage,
cross-source identity matching, a complete-game measurement or verified recovery.
The Digimon parser regression injects a labelled optional field into retained
real HTML; the injected field is not new real-source evidence. Retained #219
One Piece/Riftbound evidence is unchanged.
