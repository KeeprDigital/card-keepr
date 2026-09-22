# Architecture and decisions

These are the maintained design constraints. [CONTEXT.md](../CONTEXT.md) defines
the vocabulary; [contracts](../contracts/README.md) define current interfaces;
[the code map](../src/catalogue/README.md) explains implementation boundaries.
The linked issues retain the original decisions and implementation acceptance.

## Catalogue scope and source authority

The catalogue describes real English-language Cards, issued Printings, Products,
Releases, Printed Rules Text and publisher Errata. Original/custom cards,
tournament eligibility, ban lists, FAQs and rulings are outside scope. Supporting
source and owner evidence belongs in administration; consumer responses and
exports carry accepted facts and explicit unknowns without requiring consumers
to judge source provenance. This is the scope of former ADRs 0013–0014;
[consumer visibility](https://github.com/KeeprDigital/card-keepr/issues/213#issuecomment-5558597280)
and [card-content scope](https://github.com/KeeprDigital/card-keepr/issues/214#issuecomment-5558719187)
record the reasons.

The accepted scope includes gameplay and collectible Cards across Supported
Games, including tokens and art cards. Advertising and incidental pack inserts
remain outside scope. This expands the former rules-level-only meaning of Card;
market value does not determine admission. Non-gameplay Cards must be
representable without invented gameplay properties, and non-applicable properties
must be distinguishable from missing evidence. The shared Game Profiles represent
categories and gameplay applicability; each source's declared coverage still
needs its own evidence.

The accepted first private release scope includes completed Riftbound, Magic:
The Gathering and Pokémon support alongside the existing game scope, plus the
Hono and generated OpenAPI direction below. Magic and Pokémon are required for
that release. This is accepted scope, not a claim of implemented adapters or
verified coverage; each game's declared Source Coverage still requires its own
publication and recovery evidence.
[Expansion specification](https://github.com/KeeprDigital/card-keepr/issues/312).

Coverage should expand through multiple Sources and reconciliation. A complete
check of every selected Source does not establish that every real Card or
Printing is known; some games have no exhaustively knowable catalogue. Preserve
declared scope, known gaps and unresolved conflicts while pursuing the widest
supported coverage. Each game has an explicitly agreed, fixed set of Sources
for the first release. Additional Sources can be added later without making an
unbounded search for sources part of launch completion.

Magic's agreed launch Source is Scryfall alone; its breadth does not establish
exhaustive real-world coverage or change its status as an independent Source.
Pokémon's agreed launch Sources are TCGdex and selected official Pokémon card,
Product and correction publications. Riftbound's agreed set combines existing
Riot evidence with Piltover Archive, Riftbound DB and HexDeck, prioritizing
complementary promotional Printings since no one catalogue is assumed to contain
every promo. Each selected publication surface needs declared coverage; selecting
these Sources does not itself designate Source Authority.

Publisher ownership, transport permission and Source Authority are independent.
The owner designates authority by game, locale, region and content area; a newly
available publisher source does not silently replace that choice. Every adapter
maps into its game's shared Game Profile. Optional unfamiliar fields retain their
source values and actionable warnings; required structure, identity and evidence
integrity fail closed. This supports games with incomplete official coverage
without inventing publisher confirmation.
[Source authority decision](https://github.com/KeeprDigital/card-keepr/issues/209).

The accepted initial Source Authority designations for the expanded games are
Scryfall for Magic's card facts, Printing details and corrected card content;
TCGdex for Pokémon's card facts and Printing details, with selected official
Pokémon publications for corrected card content; and Riot for all three areas of
Riftbound content. Register these choices for their exact applicable English and
release-region scopes. Riot's registered English/US scope now starts with these
three designations; retained explicit owner decisions take precedence. Scryfall now
starts with those areas in its English/unknown-region pilot scope. Pokémon's
English/unknown-region pilot starts with TCGdex for card facts and Printing
details, and the selected official publications for corrected card content.
The initial policy selects areas per exact registered lineage, independently of
publisher ownership. Competing observations remain inspectable;
repeated claims across Sources do not establish independent corroboration or
silently override the designated authority. Corrected wording does not by itself
establish original Printed Rules Text or a dated publisher Erratum.

Coverage and freshness describe the declared Source scope. Selective refresh
carries forward unaffected facts with their actual evidence dates. A required
source failure blocks the refresh; an optional availability outage may exclude
that whole scope with a warning. Absence, withdrawal and source retirement are
separate facts; none silently reallocates identity or makes publication time a
new source observation.
[Coverage decision](https://github.com/KeeprDigital/card-keepr/issues/212#issuecomment-5557581630).

A Release date the Publisher marks as subject to change is a Tentative Release
Date: the stated date is kept with `date.tentative: true` rather than rejected
or reduced to an unknown date. The marker is present only when stated, so other
Releases keep their shape. It is an ordinary Release fact; a later observation
without the marker replaces it through reconciliation, and it never implies a
scheduled update. Before Go-Live this edits the Release definition and export
schema v5 in place.
[Tentative release dates](https://github.com/KeeprDigital/card-keepr/issues/334#issuecomment-5769592182).
Release date precision (`day`, `month`, `quarter`, `season`, `year`, `unknown`)
is one vocabulary across storage, the read contract and export schema v5, which
was edited in place before Go-Live to admit `season`
([#396](https://github.com/KeeprDigital/card-keepr/issues/396)).
A recognised day date followed by free Publisher text (for example an event
pre-sale) keeps the leading date as the Release date; the text stays verbatim as
unmapped evidence and raises `release_date_qualifier_retained` at inspection,
without new vocabulary. A same-site redirect of a page request is retained as
that request's evidence and its Location continues as one discovered Source
Request (one hop, budget-counted); the redirect is never the original content
and cross-site redirects still fail.
[Qualifier and redirect decisions](https://github.com/KeeprDigital/card-keepr/issues/334#issuecomment-5770068497).

## Identity and owner decisions

Canonical IDs are persistent allocations with retained evidence mappings, not
hashes of mutable source fields. A source URL, publisher number or image encoding
change alone cannot create a new Printing. Corrections retain redirects or
ambiguous replacement sets; a split never chooses which replacement represents a
consumer-owned copy.
[Identity decision](https://github.com/KeeprDigital/card-keepr/issues/210#issuecomment-5556048893).

An independently operated Source may supply private Card design evidence without
claiming a Publisher identity. The exact retained adapter must qualify that key;
only a source-qualified admission policy may use it. Allocation scopes the key by
game, profile, category and Source Lineage. Equal mutable facts do not merge
different qualified keys, and a changed admitted locator-to-design association
blocks for identity review while retaining prior canonical IDs. Source keys stay
in private mappings/admission evidence and never become public `official_identity`.
Scryfall Oracle UUIDs use this seam in the [Magic pilot](https://github.com/KeeprDigital/card-keepr/issues/326).

The bounded Pokémon profile interprets TCGdex's Card ID only within its Source
Lineage. Species names, Pokédex numbers, marketplace IDs and source variant IDs
do not establish canonical Card equivalence. Issued finishes, editions, sizes
and stamps distinguish the retained detailed treatments; a shared catalogue
image depicts only the treatment established by its inspected bytes. Missing
precise scans remain gaps even when an owner admits the evidenced treatment.
The selected official Garchomp correction uses `BRILLIANT-STARS-109/172`, our
normalization of the publisher's set and printed number. It is not an upstream
global identifier or a cross-reprint equivalence rule. Retain the exact set,
number and publication locator as supporting evidence. The dated correction
replaces only the evidenced Sonic Slip paragraph and its structured Card ability
text. It preserves Dragonblade, other Card facts, original Printed Rules Text and
retained observation bytes, and does not establish later corrected physical stock. Missing, ambiguous or stale targets block reconciliation; replay of
already-corrected text requires the same attributable correction history.
[Pokémon pilot](https://github.com/KeeprDigital/card-keepr/issues/328).

An art Card and a gameplay Card remain separate Cards even when they depict the
same illustration. Expose their relationship when evidence establishes it,
without merging identities. Publisher-issued foil or stamped versions of an art
Card are distinct Printings of that art Card under the ordinary treatment rules.
Identity comparison must respect the applicable Card kind and Game Profile.
A shared-artwork relationship binds the particular issued Printings and retained
observations that establish the association. It does not assert that every
Printing shares an illustration. Self-reference, missing targets and unresolved
Printing associations block the candidate.

Unresolved intake remains an Entity Proposal outside published data. Source rules
can admit sufficiently established real entities; the owner can record explicit
exceptions with evidence, but cannot waive required Game Profile structure or a
Printing's identified Card. Curated Revisions correct existing facts. Admission,
identity resolution and correction decisions do not publish a candidate.
[Admission decision](https://github.com/KeeprDigital/card-keepr/issues/211#issuecomment-5556519627).

Scryfall records whose physical faces cannot establish the required logical Card
parts retain their exact source claims and private image evidence as separate
Entity Proposals for each declared finish. A token layout alone does not
establish a token: the Magic Game Profile requires the Token type prefix. Under
the owner's ruling, a token-layout record with another gameplay type and rules
text is a gameplay Card; the named World Championships advertising inserts are
excluded as `advertising`; `Card` or `Stickers` types and self-described
reminder cards are excluded as `non_card_insert`. Excluded raw records stay in
the retained archive blocks and are counted by reason; a later refresh may admit
a sub-bucket with fresh identities. Only an otherwise-valid token-layout record
outside these rulings keeps the unresolved-category proposal path. Proposals
contribute no Card or Printing while the required structure or category remains
unresolved. A decision about one finish does not decide another, and another
printing's rules text cannot fill the source's gap. The three incomplete
reversible Adventure designs (six finishes) do not block publication; the owner
admits them afterwards as Printings of the evidenced Card with the treatment an
explicit unknown.
[Magic source assembly](https://github.com/KeeprDigital/card-keepr/issues/327).

TCGdex's declared English inventory graph retains exact Set/Card membership and
excludes the separately declared Pocket membership. Outside the qualified pilot,
a structurally valid record retains one source-scoped Entity Proposal covering
unresolved category, Card identity and treatment claims. Its raw record and
ancestor evidence remain inspectable; an attributed source image does not imply
an issued Printing or a qualified treatment. Missing image URLs create no image
request. A later capture appends evidence without rewriting the original proposal
or transferring its decision to a separately qualified target. These records
contribute no Card or Printing. Collection must close its actual discovered graph
before native preparation; registered Request Capacity still applies. The named
pilot's identities and qualified image associations remain unchanged.
Card detail discovery rejects a competing Set parent for the same opaque full
Card ID before deduplication; replay retains one request and shared images remain
independently deduplicated.
[Pokémon source assembly](https://github.com/KeeprDigital/card-keepr/issues/329).

The accepted admission direction automatically admits unambiguous, sufficiently
evidenced Cards and Printings from designated authorities after their adapters
have demonstrated reliable identity handling. Ambiguous identities and new Cards
or Printings evidenced only by supplementary Sources still require explicit owner
admission. Qualification cannot invent physical distinctions or turn unknown
properties into established facts. Unqualified adapters require owner admission
even when their lineage is authoritative; existing qualified parser contracts are
explicitly selected. Riot now qualifies a numeric publisher Printing code only
when its record locator, variant, set and collector number agree and retained
front-image evidence supplies the physical proof. Other identities remain
unresolved for explicit review. This preserves existing fingerprints and makes
no finish, back or original printed-wording inference. A later image outage
retains admitted identity and decisions with an explicit image gap. A lineage
registered with source-record novelty proof (Scryfall) instead establishes a new
qualified Printing from its structurally complete source record, so its
facts-only import publishes every such Printing with an explicit image gap;
records without an illustration identity stay unqualified proposals. Other
lineages still require retained image proof. Owner
exceptions, prior automatic decisions and category/profile equivalence survive
refresh and recovery. Admission remains separate from approval of the whole
Catalogue Candidate and publication.

Riftbound DB's bounded English pilot preserves OpenRift IDs and Riot image origins
as attributable upstream facts. Only the inspected Eclipse Herald record maps
into the shared profile; it requires an owner decision to link or admit the
supplementary observation. Promo issuance, treatment and identity claims remain
source-record Entity Proposals with private retained front images. They contribute
no partial Card or Printing, and cannot be admitted by waiving required structure.
The real duplicate Bird observations retain both evidence references without
creating two proposals. Selection and the bounded query/facet check do not
establish full-source completeness or change Riot's authority.
[Riftbound DB pilot](https://github.com/KeeprDigital/card-keepr/issues/331).

Piltover Archive's bounded English pilot reads the public gallery render (one
page and two pinned rows) as a supplementary Source under an Acquisition Budget.
Only the inspected Blazing Scorcher row maps into the shared profile, repeating
the retained Riot wording for that pinned record with Piltover's rendering kept in
the sidecar; it requires an owner decision to link, and linking adds Piltover's
front as separate retained evidence of the existing Printing rather than
corroboration of Riot's facts. The Vi ARC-001 promo lead stays an Entity Proposal
with an explicit locale issue: its retained front is a Chinese-language print, so
no English Printing is evidenced and the Card, Printing and finish claims remain
source labels. Unselected gallery rows are retained bytes only. Riot's authority
is unchanged.
[Piltover Archive pilot](https://github.com/KeeprDigital/card-keepr/issues/330).

HexDeck's bounded English pilot reads two pages of its Images-format search
(a set slice and the OGN token tail) as a supplementary Source under an
Acquisition Budget, fetching a front only at the delivery variant the page itself
renders. Its listing surface carries no rules text, artist, finish or locale, so
no listing maps into the shared profile: the pinned Blazing Scorcher and OGN T01
Buff records stay Entity Proposals with an explicit incomplete-facts issue and
private retained fronts, cannot be linked, and change no accepted Catalogue Data.
The search query parameter is client-rendered and was not guessed; the ARC promo
rows did not appear in the retained set order. Riot's authority is unchanged.
[HexDeck pilot](https://github.com/KeeprDigital/card-keepr/issues/332).

## Runtime and storage boundaries

Two Workers separate authenticated catalogue reads from administration and
mutation. They share one domain model. The API has a smaller resource inventory
and read-only routes; D1/R2 bindings themselves are resource-scoped, not
method-scoped. Evidence and backup access stay on ingestion.

Zone routes mount the Workers at `/api` and `/ingest` without another router.
`PUBLIC_BASE_URL` owns each external address. Requests outside its path receive
404 before authentication; emitted links are absolute, while stored facts and
hashed export content stay independent of the host. Route triggers must be
deployed separately from Worker versions. These preserve the decisions formerly
recorded in ADRs 0007 and the two-Worker ADR 0009.

D1 retains identities, ownership, immutable decisions, progress and digests;
private R2 retains exact source bytes, partitioned artifacts, images and backups.
An R2 object alone proves neither publication nor recovery. D1 receipts and
verified reference closure must agree with its bytes. Reconciliation uses
retained evidence rather than silently fetching a changed source.

Archive intake retains the original compressed Source Snapshot and verified
decoded blocks, with resumable record and finish progress. Only a sealed Source
Observation Set adopts those blocks as retained interpretation evidence. Permanent
proposal decisions pin their source and image dependencies atomically. Backup
verification follows retained archive and image identities independently of a
request's current snapshot pointer, requires every receipt for a shared physical
key to agree, and verifies those bytes again against the restored database.
Scryfall's default scope starts at one bulk metadata root, pins the dated
Printing-bearing archive and its compressed length, and discovers current normal
images from its selected records. Its named `facts-only` scope reads the same
pinned inventory but acquires no image: a scope's acquired discovery roles select
which discovered requests enter the run, while its sealed observations keep the
adapter's complete discovery claims. Images arrive progressively: the facts-only
import (tranche 0) publishes first, then image tranches run as ordinary complete
collections metered by the Acquisition Budget. The named four-card pilot retains
its exact requests. Its pre-Go-Live capacity migration requires current/latest-event state
agreement and completed or terminal collection, except permanently abandoned
restored collections; reservation absence alone does not establish completion.
The dated request envelope is separate from measured full-import capacity,
publication and recovery, which remain [launch work](https://github.com/KeeprDigital/card-keepr/issues/327).

Adapters may opt into bounded retained discovery context. Before interpretation,
the parse operation atomically fixes its complete chain of ancestor Source
Snapshots from the same Ingestion Run and exact adapter binding. Replays use
those snapshots even if a later capture changes the request's current pointer;
ambiguous completed parent captures prevent a new binding. A retained child
protects its ancestors, and a permanent object reference also protects the direct
siblings owned by that snapshot. Reverse ownership uses only literal stored keys,
so a parent reference cannot retain otherwise unreferenced descendants. Backup
verification fingerprints the context receipts and verifies required ancestor
bytes against both the fenced source and restored database. Context receipts
alone do not permanently retain evidence. TCGdex's production inventory graph
uses this opt-in. A proposal pins its source-record image bytes independently of
Printing qualification; cleanup and backup follow the same source, ancestor and
image closure. Bounded retained-byte proofs do not establish complete declared
capture or physical treatment coverage.
New backups record a separate proposal-evidence receipt for retained source and
literal image dependencies and verify their bytes before export and after restore.
Historical snapshots retain their original optional receipt set; archive and
ancestor receipt digests keep their original meanings.
[Pokémon source assembly](https://github.com/KeeprDigital/card-keepr/issues/329).

Collection acquisition requires a finite, run-wide Acquisition Budget, separate
from the adapter's Request Capacity. A durable Dispatch Reservation is charged
before each potential physical source call, including retries, revalidation and
same-attempt replay. Its maximum body exposure remains reserved until that exact
retrieval and writer are positively settled. Missing receipts, timeouts, absent
objects or superseded Workflow identities do not establish settlement. A
Workflow Attempt positively observed complete, errored or terminated, or whose
instance the control plane confirms absent, has stopped executing and owns no
work: a dispatch it still holds without a capture receipt settles at zero bytes
once its destination object is absent, keeping the dispatch charge, and that
attempt is recorded as failed so the replacement retrieves under a fresh
attempt and object key. A present object still requires the exact writer
verification, and any other control-plane failure blocks resume. This accepted
rule keeps a run self-healing after a hostname Workflow dies mid-fetch; the
alternative, treating only normal completion as settlement, would leave every
such run for manual termination. A storage failure or unclassified error during
a write likewise leaves the dispatch charged and unsettled under an Acquisition
Pause rather than recording a failed attempt, because the destination state is
unknown; a storage Retry Pause now arises only from abandoned attempts. A permit
is never reusable after its acknowledgement could have escaped. Admission binds
the current collection authority and budget generation; its deadline governs new
admission, not instantaneous cancellation of escaped work.

Acquisition exhaustion pauses the ordinary run while preserving its graph and
evidence. Checked, idempotent extensions only increase limits or deadline and do
not resume work or reset charges. Raw-source exposure is not wire traffic,
whole-account storage or money; downstream resource planning remains separate.
Existing runs receive no invented unlimited policy or historical dispatch count.
Prospective initialization requires quiescent, positively settled prior ownership
and a verified, deduplicated retained-body baseline; unresolved ownership blocks
it. Budget and reservation evidence belongs to backup/restore verification.
[Acquisition guard](https://github.com/KeeprDigital/card-keepr/issues/367).

Collection scheduling reads a bounded page containing the next pending shard
for each hostname. It retains Workflow identities only for dispatched shards;
later shards are selected after their predecessors finish. Hostname grouping
uses the canonical URL hostname, including IPv6 brackets and excluding ports,
while each full request URL keeps its own identity. The global emergency request
ceiling is a finite admission limit, not a measured throughput or arbitrary-host
capacity guarantee. Each Source Adapter Version keeps its separately declared
capacity. [Source intake foundation](https://github.com/KeeprDigital/card-keepr/issues/327).

## HTTP interface direction

Both Workers use Hono for HTTP routing and middleware. Separate generated OpenAPI specifications cover the complete
catalogue-read and administration HTTP interfaces, using the authoritative route
and schema definitions used by the implementation. Required generation and actual-response checks keep
the contracts aligned as routes evolve. The
[Hono implementation](../contracts/HTTP.md) routes both Workers through Hono.
The complete catalogue-read interface, including published Game Profile discovery
and API utilities, uses executable Zod OpenAPI definitions. Source and collection
administration, publication preparation/execution, and per-game candidate
preparation and inspection, identity review, corrections, Entity Proposals and
Curated Revisions, maintenance, owner software-release, backup/recovery and
retained historical run operations are also registered.
Typed owner target resolution is separate from current status inspection.
The required operation inventory and generated caller census account for every
business route, signed platform endpoint, utility and documentation registration.
[#325](https://github.com/KeeprDigital/card-keepr/issues/325) removes the temporary
routing bridge and superseded HTTP-only schemas. Retained-document validation
and domain transitions stay independent of Zod.

There are no current Catalogue Consumers to constrain this pre-Go-Live HTTP
redesign. Routes, wire formats and interface structure may change where there
is a concrete benefit; preserving existing HTTP compatibility is not a goal.
Update the repository CLI, operational callers and contract checks together with
the adopted interfaces. This freedom concerns HTTP contracts; retained evidence,
canonical identity and recovery remain governed by their existing policies.

The specification initially supports the owner's applications. Future use beyond
those applications is intended, while the first release remains private and
single-owner. Catalogue OpenAPI and its documentation are publicly readable;
catalogue data requests remain authenticated and administration documentation
stays protected. The self-contained reference can be downloaded through the CLI
and opened without a browser bearer session. Served server addresses and links
come from the active configured public base. Documentation readership and later external API access are
separate decisions; neither changes the current Catalogue Consumer definition
implicitly.

Unfiltered catalogue browsing includes gameplay and collectible Cards. Responses
identify their category, and applications can filter for the relevant categories,
including tokens and art cards. Exports and generated contracts carry the same
distinctions; collectible Cards do not require a special opt-in to be visible.

## Per-game publication and recovery

Collection, Reconciliation Operation, Catalogue Candidate, publication and Backup
Attempt have distinct identities. Workflows carry bounded cursors and references;
D1/R2 hold durable progress and candidate data. Generation fences, idempotent
receipts and deterministic successor identities prevent stale writers and replay
from renewing authority or resource budgets.

The owner can inspect the complete candidate and its semantic before/after
changes, images, exclusions, warnings and evidence. Whole-candidate approval
binds its manifest and exact Game Catalogue Revision predecessor. It requires no
per-item acknowledgement and keeps the original seven-day deadline after approval,
pause or resume. Publication does not recalculate facts when an applicability date
passes. Other games may prepare independently.

Immutable artifacts and query projections are prepared before a small atomic
composition switch. The switch rechecks approval, predecessor, deadline and
recovery fences and reserves the new composition's backup. A subsequent publication
waits for its verified backup checkpoint. SQL snapshotting temporarily fences
writers; actual Catalogue Recovery keeps a global fence through verified owner
acceptance. Current plus two predecessor revisions retain operational recovery
protection. These are integrity rules, not a promise of production throughput.
[Publication decision](https://github.com/KeeprDigital/card-keepr/issues/214#issuecomment-5558801899).

Export deletion affects only an eligible non-current package through its expiring
plan, exact confirmation and manifest-last removal. Shared objects, immutable
identities, digests and tombstones remain protected. Source/staging cleanup uses
separate positively inventoried ownership and reference checks; age alone never
authorizes deletion. See [maintenance](runbooks/maintenance.md).

## Definition changes and Go-Live

Before Go-Live, keep one definition per adapter lineage, Game Profile, export
schema, cursor and serialization profile. Edit it in place and retain existing
identifier suffixes. Regenerate incompatible derived data. Guarded forward
migrations update populated databases; fold them into the baseline when an
approved recreation occurs and before the Go-Live freeze. Documentation cleanup
or a schema change does not authorize resetting a database or deleting evidence.

The Card category expansion records its definition in each new preparation's
immutable pins. Sealing validates every Card and Printing, including carried
facts and relationships after identity corrections. Older pending candidates
cannot prepare publication artifacts or receive a new approval. Normal fresh
collection and reconciliation preserve their canonical IDs and derive category
and applicability from retained profile facts; approval still covers the whole
candidate. Games may refresh sequentially while other game components remain
unchanged. Until every component has the expanded definition, entity projections
return 503 (pinned collection cursors return 409 with a restart link) and generated
current export manifests return 503, including conditional requests. Existing
explicit revision/component downloads preserve verified historical bytes and
their original access, deletion, range and conditional rules. SQL backup and
restore verify the exact mixed composition, allowing refresh to progress without
rewriting its retained evidence. See [publication](runbooks/publication.md) and
[#313](https://github.com/KeeprDigital/card-keepr/issues/313).

Legacy eligibility uses generated record readiness and partial indexes, maintained
automatically by migration and publication/repair writes. Reads seek unready
records without rescanning immutable document bytes. Readiness is distinct from
the semantic validation required when sealing new candidates.

From Go-Live, definitions become immutable and advance by explicit versions;
earlier retained export majors stay readable and the baseline is never edited.
Adapter registrations retain attribution; executable parsers keep the current
and immediate predecessor versions, retiring older code only after pinned active
runs finish. Cross-version snapshot reparse remains deferred: parser corrections
use fresh collection followed by ordinary inspection and approval. Operational
revision/evidence retention is separate from definition compatibility. These
preserve ADRs 0004, 0006 and 0008 and the
[reparse decision](https://github.com/KeeprDigital/card-keepr/issues/215#issuecomment-5558885829).

Migrations after `0001_baseline.sql` must assert the expected previous schema
level before any change, abort without writes on mismatch, and advance the level
once. Preserve seeded identities and trigger order when folding; the schema
hygiene and baseline tests verify equivalence.

## Software release direction

The implemented guarded release requires exact-commit CI, immutable owner
confirmation, a canonical D1 lease, verified bindings and recovery evidence,
paired Worker activation and smoke checks. Migration failures require compatible
roll-forward. Bearer credentials have primary and replacement slots; the former
attested rotation subsystem is retired.

The accepted environment direction is automatic dev delivery of passing merges,
manual selection of an exact commit for isolated staging, then guarded promotion
of that same validated commit to production. Staging owns its own catalogue;
production data still requires its own candidate approval. This direction does
not establish that the environment rollout or Go-Live has occurred. Use the
[release procedure](runbooks/production-release.md) for the available path and
[issue #216](https://github.com/KeeprDigital/card-keepr/issues/216) for readiness.
[Environment decision](https://github.com/KeeprDigital/card-keepr/issues/215#issuecomment-5558986254).

The isolated dev implementation uses signed GitHub workflow identity to prepare
the exact passing main commit against its own catalogue, then reuses the guarded
release executor and canonical lease. It verifies uploaded versions against the
fully activated pair before binding and smoke success. Resource namespaces,
CLI profiles and Disposable Restore deletion are environment-scoped. The owner
selected the existing production account for dev and staging and accepted its
account-wide deployment permissions. Each environment must retain separate data,
resource namespaces, credentials and routes; application checks enforce target
selection within that shared authority. [Account decision](https://github.com/KeeprDigital/card-keepr/issues/236).
The owner selected `card-dev.keepr.digital` and `card-staging.keepr.digital` so
both environments fit the existing `*.keepr.digital` certificate coverage.
Production retains `card.keepr.digital`.
The [dev procedure](runbooks/isolated-dev.md) requires a guarded first installation
and real automatic-deployment evidence before the rollout is established.

The manual staging implementation retains one immutable owner intent in
production, including the actual production starting target/schema and exact
selected commit. A signed manual staging workflow claims it once; lost-response
replay preserves the original claim and deadline. Staging prepares against its
own catalogue through the shared guarded executor and retains separate deployment,
migration-rehearsal and required-validation outcomes. Every staging release
requires the same checks: exact-commit CI, migration rehearsal and live smoke.
Extended retained-source scenarios run once per release candidate and are
recorded as a per-commit `extended-scenarios` status. They are not replayed at
release time, and no production-version read or transition classifier selects
them ([owner direction](https://github.com/KeeprDigital/card-keepr/issues/238#issuecomment-5760797529)).
No merge deploys staging, and no staging catalogue is copied to production. The
[staging procedure](runbooks/manual-staging.md) distinguishes available code from
live acceptance under [#237](https://github.com/KeeprDigital/card-keepr/issues/237).
[#238](https://github.com/KeeprDigital/card-keepr/issues/238) owns continuation of
that intent through fresh production guards; a short-lived staging plan cannot
authorize a later production deployment.
