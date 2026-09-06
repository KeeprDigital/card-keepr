# Card Catalogue

Card Keepr describes real cards across publishers and sources in a form that can be consumed consistently across personal applications.

## Language

**Supported Game**:
A card game included in the catalogue, regardless of publisher.
_Avoid_: Franchise, title

**Publisher**:
An organization that publishes a Supported Game. A Source operator or distribution partner is not necessarily its Publisher.
_Avoid_: Source, Source Authority

**Catalogue Consumer**:
An application or automation owned by the catalogue’s owner that reads card data, including catalogue and inventory management systems that reference individual Printings. Third-party users and anonymous public clients are not Catalogue Consumers.
_Avoid_: Customer, public API user

**Supported Locale**:
An English-language edition represented in the catalogue, independently of its Source, release region or play format. Non-English editions are outside the initial catalogue.
_Avoid_: Translation

**Catalogue Data**:
Published facts about Supported Games, their cards, and related official releases. Personal collections, wishlists, decks, trades, and other owner-specific state are not Catalogue Data.
_Avoid_: Collection data, inventory

**Game Profile**:
A shared schema defining the shape and meaning of a Supported Game’s rules-relevant Catalogue Data independently of any Source’s presentation; all sources for the game map to the applicable profile. Its definitions evolve with game content and field meanings, with one definition edited in place before Go-Live and explicitly versioned definitions from Go-Live.
_Avoid_: Source schema, adapter payload

**Source**:
An identifiable origin of evidence about real cards, including publisher publications, supplemental catalogues and owner-supplied evidence. Its origin is distinct from its authority over Catalogue Data.
_Avoid_: Canonical fact, authority

**Official Source**:
A publisher-owned publication from which evidence about its cards is obtained. Official ownership does not automatically supersede a selected Source Authority.
_Avoid_: Community database, marketplace listing

**Source Authority**:
An owner-designated Source for a Supported Game’s card facts, printing details or corrected card content within the applicable locale and release region. Designation is separate from publisher confirmation and remains in effect until the owner explicitly changes it.
_Avoid_: Official Source, trust score, contributor

**Source Lineage**:
The stable identity of one Source across dated captures and compatible Source Adapter Versions. It distinguishes independently published regional or game sources without treating each URL or response as a new source.
_Avoid_: Request URL, Source Snapshot, hostname

**Source Coverage**:
The declared area of a Source represented by a check, including its applicable Supported Game, locale and any bounded subset. Completeness establishes that this declared scope was successfully checked at a stated time, not that every real Card or Printing in the game is represented.
_Avoid_: Game completeness, all cards

**Source Adapter Version**:
A parser contract registered to exactly one Source Lineage, Supported Game, and Game Profile. From Go-Live it is immutable and advances by registration; before Go-Live each Source Lineage has exactly one, edited in place.
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
The non-terminal paused condition an Ingestion Run enters when admitting a dynamically discovered request batch would exceed its Request Capacity. Every retained observation, pending Source Request, the run's collection reservation, and the run identity survive unchanged, and the run cannot parse, reconcile, await approval, or publish until the owner acts. It records nothing as failed and is distinct from a Cloudflare Workflow instance's own paused status.
_Avoid_: Failed run, cancelled run, Workflow instance pause

**Capacity Extension**:
An owner-initiated, idempotent, compare-and-set administration action that raises one capacity-paused Ingestion Run's effective request capacity to a larger absolute value and atomically advances that run's capacity generation. It binds the expected current capacity and generation, stays below the global emergency ceiling, leaves the Source Adapter Version's registered Request Capacity untouched, and never resumes collection itself: the run returns to collecting only through the separate resume action.
_Avoid_: Mutable quota, adapter capacity change, resumed run

**Retry Pause**:
The non-terminal paused condition an Ingestion Run enters when one Source Request exhausts its bounded transport or storage retries while retrying that exact request remains semantically safe. Nothing is recorded as failed: the request stays pending with its append-only attempt history, and resuming the same run opens that request's next bounded retry generation without deleting or renumbering earlier attempts. Source-contract violations and evidence-integrity failures remain terminal instead of pausing, and a Printing Image request never pauses or fails the run: whether it exhausts its transport retries or meets a terminal outcome (a missing or redirected file, a rejected revalidation, a body-contract violation), the failure is tolerated and recorded on that request alone under a class-specific code while collection continues and reconciliation publishes the Printing without the image, naming the gap explicitly.
_Avoid_: Failed request, Capacity Pause, linked retry run

**Workflow Attempt**:
One append-only recorded execution identity of the parent or hostname-shard Cloudflare Workflow driving an Ingestion Run's collection. A recovery supersedes an attempt by opening a deterministic new identity without deleting earlier ones, exactly one attempt per scope is current, and no attempt changes the Ingestion Run identity, its Source Requests, or its retained evidence.
_Avoid_: Fetch attempt, retry generation, mutable workflow id

**Workflow Pause**:
The non-terminal paused condition an Ingestion Run enters when its collection Workflow is deterministically observed stalled, errored, terminated, or unavailable while the retained collection work remains valid, or when the owner deliberately pauses a collecting run (reason `owner_requested`). Stall classification derives last progress from persisted lifecycle events and never counts a host pacing wait against its persisted deadline, a durable Retry-After wait, or a scheduled retry as a stall; nothing is recorded as failed, the current Workflow Attempt is abandoned, and resuming opens a new Workflow Attempt for the same run. Pause then Collection Termination is the only way to stop a collecting run.
_Avoid_: Failed run, Capacity Pause, Retry Pause, Workflow instance pause

**Collection Termination**:
The owner's explicit, idempotent decision to abandon a paused Ingestion Run. It is the only path from paused to terminal: the run keeps every retained observation, pause record, and Workflow Attempt as audit evidence, can never resume, extend capacity, parse, reconcile, or publish, and releases that run's collection reservation.
_Avoid_: Cancelled run, deleted run, Workflow instance termination, linked retry

**Curated Revision**:
An immutable owner-authored correction or supplement applied exceptionally during reconciliation while preserving Official Source observations and its own provenance. Changes supersede or retire it rather than rewriting history, and it does not turn a third-party source into an Official Source.
_Avoid_: Silent override, scrape fix, Curated Revision Proposal

**Curated Revision Proposal**:
The owner-authored request for a Curated Revision: the Supported Game, the exact field or relationship it targets, the asserted value or presence, the rationale, the retained evidence it cites, its effective interval, and the Official Source state the owner reviewed. It is validated against that game's current Game Catalogue Revision and becomes a Curated Revision only when created exactly as validated; it is never edited in place and is not itself part of any Catalogue Revision.
_Avoid_: Curated Revision, patch, override, Catalogue Candidate

**Card**:
A rules-level game piece representing a real card, with equivalence defined by its Supported Game's Game Profile rather than functional similarity or publisher number alone. A Card may have multiple Printings; original or custom creations are excluded regardless of how a record enters the catalogue.
_Avoid_: Artwork variant, physical copy, custom card

**Entity Proposal**:
A retained proposal to add a real Card or Printing, holding its evidence and unresolved admission or identity questions outside published Catalogue Data. It may be admitted once sufficiently established, linked to an existing entity, or rejected with a recorded reason.
_Avoid_: Catalogue Candidate, Curated Revision Proposal, published Card

**DON!! Card**:
The unnumbered rules-level resource Card used by One Piece Card Game. Its differing official artworks and treatments are Printings, not distinct Cards.
_Avoid_: DON!! Card Number, physical copy

**Printing**:
A distinct issued appearance, treatment or printed-content version of a Card, including established differences in artwork, foil, stamps, printed text or faces/backs. Ordinary manufacturing variation, a changed source image alone, or distribution through another Product or event does not alone create a Printing.
_Avoid_: Card, owned copy

**Printing Image**:
An evidence-bearing image from a Source depicting a specific role or face of a Printing. One Printing may have multiple Printing Images.
_Avoid_: Card identity

**Source Snapshot**:
A dated, unmodified observation captured from a Source. It preserves the source evidence independently of normalized Catalogue Data.
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
The complete, immutable next version of Catalogue Data proposed for one Supported Game from selected retained evidence, bound to the exact Game Catalogue Revision it expects to succeed. It is inspected, approved, or rejected only as a whole and exactly as reconciled; its seven-day publication deadline remains in force after approval.
_Avoid_: Candidate printing, draft revision, staged catalogue, Curated Revision Proposal, search result

**Reconciliation Context**:
The immutable binding between a reconciliation outcome and the retained evidence it was derived from: the selected Source Snapshots, Source Observation Sets, Source Lineages and their Ingestion Runs. It keeps a Catalogue Candidate, or a blocked reconciliation, inspectable after the fact and every reconciliation warning attributable to its evidence.
_Avoid_: Reconciliation Clock, Source Observation Set, Catalogue Candidate, Evidence Plan

**Game Catalogue Revision**:
An atomically published version of one Supported Game's Catalogue Data, produced from its exact approved Catalogue Candidate. Other Supported Games can advance independently without changing this version.
_Avoid_: Game Profile, Catalogue Candidate

**Catalogue Revision**:
A consistent published composition of Game Catalogue Revisions. Each game advances independently, while a Catalogue Revision identifies the exact versions viewed or exported together.
_Avoid_: Curated Revision, Source Snapshot, database version

**Catalogue Export**:
An immutable machine-readable package of accepted Catalogue Data and explicit unknowns for one Catalogue Revision, intended for offline use by Catalogue Consumers. Supporting evidence and admission history are administrative records, not part of the Catalogue Export.
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
One serialized deployment of compatible Card Keepr schema and Worker versions
promoted from an owner-initiated staging release attempt after validation and
production guards pass. It is operational and must not be shortened to Release,
which is a Product availability event.
_Avoid_: Release, ordinary CI, unguarded deployment

**Spine Revision**:
The schema-valid Catalogue Revision pointer (`catrev_spine_000`) a fresh
catalogue database starts at until the first approved candidate is published.
It is a pointer, not a published Catalogue Revision, and is never retained.
_Avoid_: Bootstrap revision, empty revision, first revision

**Bootstrap Mode**:
The state of the guarded Production Release while the Spine Revision is
current and no Catalogue Revision has ever been published. It relaxes only the
gates that presuppose published data (recovery bookmark, verified backup,
retained window, smoke targets) and switches off permanently at the first
publication.
_Avoid_: Unguarded deployment, direct `wrangler deploy`, pre-migration fence

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
The publisher-corrected rules-level text for a Card represented by the retained Source Observations selected for its published version. It is distinct from the original printed text and does not imply continuous monitoring or scheduled activation of corrections.
_Avoid_: Printed Rules Text, silently corrected text

**Erratum**:
An official correction to Card or Printing facts that preserves the original facts and its supporting evidence. Any published dates remain evidence about that correction, not a promise of scheduled catalogue updates.
_Avoid_: Curated Revision, silent overwrite

**Reconciliation Clock**:
The recorded time of a Catalogue Candidate's reconciliation, distinct from the capture times of its selected Source Snapshots. Passing a correction's stated applicability date does not change or invalidate the retained facts proposed by that candidate.
_Avoid_: Publication time, wall clock
