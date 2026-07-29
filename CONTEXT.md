# Card Catalogue

Card Keepr describes Bandai card games and their published cards in a form that can be consumed consistently across personal applications.

## Language

**Supported Game**:
A Bandai card game included in the catalogue. The initial set is One Piece Card Game, Dragon Ball Super Card Game Fusion World, Digimon Card Game, and Gundam Card Game.
_Avoid_: Franchise, title

**Catalogue Consumer**:
An application or automation owned by the catalogue’s owner that reads card data. Third-party users and anonymous public clients are not Catalogue Consumers.
_Avoid_: Customer, public API user

**Supported Locale**:
An English-language edition represented by Bandai’s official English or Oceania catalogue sources. Non-English editions are outside the initial catalogue.
_Avoid_: Translation

**Catalogue Data**:
Published facts about Supported Games, their cards, and related official releases. Personal collections, wishlists, decks, trades, and other owner-specific state are not Catalogue Data.
_Avoid_: Collection data, inventory

**Game Profile**:
A versioned schema for rules-relevant, game-specific Catalogue Data that does not expose an Official Source’s presentation or scraper shape.
_Avoid_: Source schema, adapter payload

**Official Source**:
A Bandai-owned publication from which Catalogue Data is obtained. It is the catalogue’s normal authority.
_Avoid_: Community database, marketplace listing

**Curated Revision**:
An immutable owner-authored correction or supplement applied exceptionally during reconciliation while preserving Official Source observations and its own provenance. Changes supersede or retire it rather than rewriting history, and it does not turn a third-party source into an Official Source.
_Avoid_: Silent override, scrape fix

**Card**:
A rules-level game piece normally identified within a Supported Game by its official card number. The unnumbered One Piece DON!! Card is identified by its official functional designation. A Card may have multiple Printings.
_Avoid_: Artwork variant, physical copy

**DON!! Card**:
The unnumbered rules-level resource Card used by One Piece Card Game. Its differing official artworks and treatments are Printings, not distinct Cards.
_Avoid_: DON!! Card Number, physical copy

**Printing**:
A particular officially distinguished appearance or treatment of a Card, such as alternate artwork, foil treatment, promotional treatment, or reprint. Distribution through another Product or event does not alone create a Printing.
_Avoid_: Card, owned copy

**Printing Image**:
An Official Source image depicting a specific role or face of a Printing. One Printing may have multiple Printing Images.
_Avoid_: Card identity, user-uploaded scan

**Source Snapshot**:
A dated, unmodified observation captured from an Official Source. It preserves what Bandai published independently of normalized Catalogue Data.
_Avoid_: Catalogue export, database backup

**Source Observation**:
A provenance-bearing fact or relationship read from a Source Snapshot. It remains distinct from the normalized Catalogue Data it may support.
_Avoid_: Canonical fact, Curated Revision

**Ingestion Run**:
One owner-initiated attempt to capture Source Snapshots and reconcile them into current Catalogue Data. Its outcome remains auditable even though the ordinary API exposes the current catalogue.
_Avoid_: Automatic refresh, API request

**Catalogue Revision**:
An atomically published version of current Catalogue Data produced by a successful Ingestion Run across its selected Supported Games; data for unselected Supported Games carries forward unchanged.
_Avoid_: Curated Revision, Source Snapshot, database version

**Catalogue Export**:
An immutable machine-readable package of normalized Catalogue Data for one Catalogue Revision, intended for offline use by Catalogue Consumers.
_Avoid_: Source Snapshot, database backup, live API response

**Product**:
An official release grouping associated with Cards or Printings, such as a booster set, starter deck, or promotional release.
_Avoid_: Marketplace listing, owned sealed product

**Release**:
A region-scoped availability event for a Product, expressed with the precision Bandai publishes.
_Avoid_: Product, Distribution Context

**Distribution Context**:
An official context through which a Printing is made available, such as a Product, tournament pack, winner prize, or promotion.
_Avoid_: Product, Source Bucket

**Source Bucket**:
An Official Source grouping used to discover or classify source records. It is evidence about catalogue membership, not necessarily a Product or Distribution Context.
_Avoid_: Product, release

**Printed Rules Text**:
The rules text known to appear on a physical Printing.
_Avoid_: Effective Rules Text, source page text

**Effective Rules Text**:
The current official rules-level text for a Card after applicable Errata.
_Avoid_: Printed Rules Text, silently corrected text

**Erratum**:
An official, effective-dated correction to published Card or Printing facts that preserves the facts it supersedes.
_Avoid_: Curated Revision, silent overwrite

**Legality Rule**:
An effective-dated official assertion governing Card eligibility, copy limits, combinations, or release and rotation constraints within a stated play context.
_Avoid_: Ruling, boolean legal flag

**Legality Status**:
A Card’s eligibility in organized play for a particular date and context, derived from applicable Legality Rules.
_Avoid_: Ruling, format guide
