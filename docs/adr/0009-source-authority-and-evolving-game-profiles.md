# Source authority is designated independently of publisher ownership

Accepted 6 September 2026 through [Decide source authority and publisher-independent game boundaries](https://github.com/KeeprDigital/card-keepr/issues/209). Card Keepr must describe real cards across publishers, including games with incomplete or unavailable official card and rules sources. Each source maps through an adapter into the game's shared Game Profile; the owner designates authority independently of source ownership so missing official coverage does not exclude a game or force supplemental evidence to masquerade as publisher confirmation.

## Decision

Every Card represents a real card. Owner manual entry is a stopgap for adding missing real-card records. Original/custom cards are excluded. Community contribution is a possible future extension, but submission, accounts, voting and moderation are not current requirements.

Publisher, Source and Source Authority are distinct concepts. Official Source remains the publisher-owned subset of Source. The owner can designate sources separately for card facts, printing details and corrected card content, scoped to the applicable game, locale and release region. Suitable official sources are the default; non-publisher sources can be designated where needed. A designation permits authoritative interpretation in its scope without implying publisher confirmation. Manual entry preserves its own evidence and does not automatically override an established authority. Network access permission does not establish fact authority.

A newly available official source does not silently supersede a designated authority. Contradictory evidence is retained and flagged for owner review; changing the authority requires an explicit owner decision. Detailed conflict resolution, admission evidence and publication blocking are separate decisions, not implied by this precedence rule.

Each source has an adapter/transformer boundary for its presentation and acquisition format. Every adapter for a game maps into the applicable shared Game Profile. The game model defines canonical shape and meaning independently of source presentation. This replaces the assumption that discovery formats and shared game contracts must be limited to the current Bandai adapters.

Source presentation changes belong in adapters. New optional fields retain original values and evidence with actionable schema-review warnings. Changed game meanings require deliberate Game Profile changes rather than coercion into obsolete interpretations. Uncertain interpretations remain explicit instead of becoming invented canonical values. Optional additions must not by themselves fail the whole refresh; identity, required structure and rules-affecting uncertainty still require the later admission/conflict decision's handling.

Initial ingestion remains English-only. Card language, release region and play format are separate dimensions. A different source or play region does not by itself establish a different Card; exact Card/Printing identity remains a separate decision.

## Versioning and existing contracts

ADR 0008 remains in force: before Go-Live, keep one adapter definition per lineage and one Game Profile per game, edit them in place and regenerate incompatible derived data. Do not begin compatibility retention or version bumps now. Go-Live is the initial release serving Catalogue Consumers, not an earlier deployment. From Go-Live, adapters and schemas use explicit versions so retained interpretations remain attributable. Existing operational Catalogue Revision retention and recovery protection are unaffected.

This decision replaces the Bandai-only and official-source-only contribution assumptions in the original PRD and glossary. [ADR 0014](0014-card-content-without-tournament-eligibility.md) subsequently removes tournament eligibility and legality authority requirements while retaining printed and corrected card content; [ADR 0013](0013-consumer-facts-and-complete-administrative-review.md) places supporting provenance in administration. ADR 0004's unimplemented reparse promise remains unsettled. The final handoff must explicitly implement or revise that promise before freeze; version registration alone does not provide reparsing.

## Evidence and trade-off

[Research real Bandai, supplemental, and Riftbound source evidence](https://github.com/KeeprDigital/card-keepr/issues/208#issuecomment-5550165033) found distinct publisher/supplemental identifiers and Riot errata preceding gallery updates. The application review reproduced a refresh failure on an unknown optional Digimon field. These support separating source formats, effective meaning and authority; none establishes that every supplemental claim is correct. Owner designation adds policy decisions and review work, but supports games without adequate official sources while keeping provenance truthful.
