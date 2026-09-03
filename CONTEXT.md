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

**Source Lineage**:
The stable identity of one Official Source across dated captures and compatible Source Adapter Versions. It distinguishes independently published regional or game sources without treating each URL or response as a new source.
_Avoid_: Request URL, Source Snapshot, hostname

**Source Adapter Version**:
A parser contract registered to exactly one Source Lineage, Supported Game, and Game Profile. From Go-Live it is immutable and a new version may reparse retained Source Snapshots without changing their captured bytes; before Go-Live each Source Lineage has exactly one, edited in place.
_Avoid_: Generic parser name, mutable scraper, Source schema

**Go-Live**:
The first Production Release that serves Catalogue Consumers. Before it, every definition exists in exactly one version and nothing is retained for compatibility; from it, versions are immutable and advance by registration.
_Avoid_: Version one, launch, first deploy

**Source Request**:
One immutable planned retrieval within an Ingestion Run's collection coverage, identified stably by its Source Lineage, request role, and immutable identity whether it originates from the initial Evidence Plan, an Official Source Collection Plan, or dynamic discovery. Repeated fetch attempts and retained evidence attach to the same Source Request rather than creating a new one.
_Avoid_: Fetch attempt, Source Snapshot, request URL

**Request Capacity**:
The bound each exact Source Adapter Version owns on the unique source request identities one Source Lineage may hold within an Ingestion Run, counted across initial and dynamically discovered roles. A larger global emergency ceiling constrains every Request Capacity; from Go-Live it is immutable and changing it requires registering a new Source Adapter Version, while one capacity-paused Ingestion Run's effective capacity may be raised exceptionally through a Capacity Extension.
_Avoid_: Cloudflare platform limit, mutable quota, rate limit

**Capacity Pause**:
The non-terminal paused condition an Ingestion Run enters when admitting a dynamically discovered request batch would exceed its Request Capacity. Every retained observation, pending Source Request, the single active-run reservation, and the run identity survive unchanged, and the run cannot parse, reconcile, await approval, or publish until the owner acts. It records nothing as failed and is distinct from a Cloudflare Workflow instance's own paused status.
_Avoid_: Failed run, cancelled run, Workflow instance pause

**Capacity Extension**:
An owner-initiated, idempotent, compare-and-set administration action that raises one capacity-paused Ingestion Run's effective request capacity to a larger absolute value and atomically advances that run's capacity generation. It binds the expected current capacity and generation, stays below the global emergency ceiling, leaves the Source Adapter Version's registered Request Capacity untouched, and never resumes collection itself: the run returns to collecting only through the separate resume action.
_Avoid_: Mutable quota, adapter capacity change, resumed run

**Retry Pause**:
The non-terminal paused condition an Ingestion Run enters when one Source Request exhausts its bounded transport or storage retries while retrying that exact request remains semantically safe. Nothing is recorded as failed: the request stays pending with its append-only attempt history, and resuming the same run opens that request's next bounded retry generation without deleting or renumbering earlier attempts. Source-contract violations and evidence-integrity failures remain terminal instead of pausing.
_Avoid_: Failed request, Capacity Pause, linked retry run

**Workflow Attempt**:
One append-only recorded execution identity of the parent or hostname-shard Cloudflare Workflow driving an Ingestion Run's collection. A recovery supersedes an attempt by opening a deterministic new identity without deleting earlier ones, exactly one attempt per scope is current, and no attempt changes the Ingestion Run identity, its Source Requests, or its retained evidence.
_Avoid_: Fetch attempt, retry generation, mutable workflow id

**Workflow Pause**:
The non-terminal paused condition an Ingestion Run enters when its collection Workflow is deterministically observed stalled, errored, terminated, or unavailable while the retained collection work remains valid. Stall classification derives last progress from persisted lifecycle events and never counts a durable pacing sleep, Retry-After wait, or scheduled retry as a stall; nothing is recorded as failed, and resuming opens a new Workflow Attempt for the same run.
_Avoid_: Failed run, Capacity Pause, Retry Pause, Workflow instance pause

**Collection Termination**:
The owner's explicit, idempotent decision to abandon a paused Ingestion Run. It is the only path from paused to terminal: the run keeps every retained observation, pause record, and Workflow Attempt as audit evidence, can never resume, extend capacity, parse, reconcile, or publish, and releases the single active-run reservation so a new Ingestion Run may start.
_Avoid_: Cancelled run, deleted run, Workflow instance termination, linked retry

**Curated Revision**:
An immutable owner-authored correction or supplement applied exceptionally during reconciliation while preserving Official Source observations and its own provenance. Changes supersede or retire it rather than rewriting history, and it does not turn a third-party source into an Official Source.
_Avoid_: Silent override, scrape fix, Curated Revision Proposal

**Curated Revision Proposal**:
The owner-authored request for a Curated Revision: the Supported Game, the exact field or relationship it targets, the asserted value or presence, the rationale, the retained evidence it cites, its effective interval, and the Official Source state the owner reviewed. It is validated against the current Catalogue Revision and becomes a Curated Revision only when created exactly as validated; it is never edited in place and is not itself part of any Catalogue Revision.
_Avoid_: Curated Revision, patch, override, Catalogue Candidate

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

**Source Observation Set**:
The immutable result of applying one Source Adapter Version to one Source Snapshot. Reprocessing with a new idempotency key appends another set rather than replacing an earlier interpretation; retrying the same parse intent returns its existing set.
_Avoid_: Source Snapshot, Catalogue Data, mutable parse result

**Evidence Plan**:
The persisted, immutable initial request plan for one Ingestion Run, including its Source Lineage and Source Adapter Version. For a complete Official Source adapter it contains the single discovery request and is never expanded after discovery.
_Avoid_: Ingestion Run, automatic crawl, mutable request queue

**Official Source Collection Plan**:
The separately immutable set of bounded follow-up requests derived from retained discovery evidence for a complete Official Source adapter. It extends an Ingestion Run's collection coverage without modifying the original Evidence Plan.
_Avoid_: Evidence Plan, mutable request queue, automatic crawl

**Ingestion Run**:
One owner-initiated attempt to capture Source Snapshots and reconcile them into current Catalogue Data. Its outcome remains auditable even though the ordinary API exposes the current catalogue.
_Avoid_: Automatic refresh, API request

**Catalogue Candidate**:
The complete, immutable next version of Catalogue Data that one Ingestion Run's reconciliation puts forward for its selected Supported Games, bound to the exact Catalogue Revision it expects to succeed. It is inspected, approved, or rejected only as a whole and exactly as reconciled, it expires unapproved after a bounded window, and no other path turns it into a Catalogue Revision.
_Avoid_: Candidate printing, draft revision, staged catalogue, Curated Revision Proposal, search result

**Reconciliation Context**:
The immutable binding between one Ingestion Run's reconciliation outcome and the retained evidence it was derived from: the Source Snapshots, Source Observation Sets, and Source Lineages that reconciliation read. It keeps a Catalogue Candidate, or a blocked reconciliation, inspectable after the fact and every reconciliation warning attributable to its evidence.
_Avoid_: Reconciliation Clock, Source Observation Set, Catalogue Candidate, Evidence Plan

**Catalogue Revision**:
An atomically published version of current Catalogue Data produced by a successful Ingestion Run across its selected Supported Games; data for unselected Supported Games carries forward unchanged.
_Avoid_: Curated Revision, Source Snapshot, database version

**Catalogue Export**:
An immutable machine-readable package of normalized Catalogue Data for one Catalogue Revision, intended for offline use by Catalogue Consumers.
_Avoid_: Source Snapshot, database backup, live API response

**Backup Attempt**:
An immutable record of one effort to preserve and prove recovery of a Catalogue Revision. A failed Backup Attempt may have at most one retry child, and only the latest failed leaf may be retried.
_Avoid_: Mutable retry, Catalogue Export

**Disposable Restore**:
A temporary restoration used only to prove that a Backup Attempt can recover its Catalogue Revision.
_Avoid_: Recovery operation, current catalogue

**Catalogue Recovery**:
An immutable, owner-accepted operation that restores the current catalogue from
one exact verified Backup Attempt, either through its D1 Time Travel bookmark or
through a replacement database. It is distinct from the Backup Attempt's
Disposable Restore: that restore proves recoverability, while Catalogue Recovery
changes the production catalogue and keeps mutation blocked until verification
and explicit acceptance.
_Avoid_: Backup Attempt, Disposable Restore, deployment

**Restore Generation**:
One clean Disposable Restore target within a Backup Attempt. A new generation supersedes an ambiguous or failed import instead of reusing its populated target.
_Avoid_: Backup Attempt, database version

**Restore Phase**:
The durable stage of a Restore Generation from target preparation through import and verification.
_Avoid_: Backup Attempt state, Ingestion Run state

**Backup Retention**:
The policy that preserves the newest successful Backup Attempt indefinitely and older dated successful Backup Attempts for the accepted period.
_Avoid_: Attempt expiry, source retention

**Product**:
An official release grouping associated with Cards or Printings, such as a booster set, starter deck, or promotional release.
_Avoid_: Marketplace listing, owned sealed product

**Release**:
A region-scoped availability event for a Product, expressed with the precision Bandai publishes.
_Avoid_: Product, Distribution Context

**Production Release**:
One serialized, owner-dispatched deployment of compatible Card Keepr schema and
Worker versions through the guarded production workflow. It is operational and
must not be shortened to Release, which is a Product availability event.
_Avoid_: Release, ordinary CI, unguarded deployment

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

**Reconciliation Clock**:
The authenticated reconciliation request time used to decide which effective-dated official facts apply to a Catalogue Candidate. A Catalogue Candidate cannot cross an applicability date while awaiting approval.
_Avoid_: Publication time, wall clock

**Legality Rule**:
An effective-dated official assertion governing Card eligibility, copy limits, combinations, or release and rotation constraints within a stated play context.
_Avoid_: Ruling, boolean legal flag

**Legality Status**:
A Card’s eligibility in organized play for a particular date and context, derived from applicable Legality Rules.
_Avoid_: Ruling, format guide

**Unresolved Target Scope**:
The explicit declaration that an official rule's affected-Card set is an open publisher predicate: enumerated known matches are retained as Cards while unenumerated (including future) printings remain in scope, so every overlapping Legality Status query answers indeterminate rather than silently omitting the rule.
_Avoid_: Compiled pair list, global ban
