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

Publisher ownership, transport permission and Source Authority are independent.
The owner designates authority by game, locale, region and content area; a newly
available publisher source does not silently replace that choice. Every adapter
maps into its game's shared Game Profile. Optional unfamiliar fields retain their
source values and actionable warnings; required structure, identity and evidence
integrity fail closed. This supports games with incomplete official coverage
without inventing publisher confirmation.
[Source authority decision](https://github.com/KeeprDigital/card-keepr/issues/209).

Coverage and freshness describe the declared Source scope. Selective refresh
carries forward unaffected facts with their actual evidence dates. A required
source failure blocks the refresh; an optional availability outage may exclude
that whole scope with a warning. Absence, withdrawal and source retirement are
separate facts; none silently reallocates identity or makes publication time a
new source observation.
[Coverage decision](https://github.com/KeeprDigital/card-keepr/issues/212#issuecomment-5557581630).

## Identity and owner decisions

Canonical IDs are persistent allocations with retained evidence mappings, not
hashes of mutable source fields. A source URL, publisher number or image encoding
change alone cannot create a new Printing. Corrections retain redirects or
ambiguous replacement sets; a split never chooses which replacement represents a
consumer-owned copy.
[Identity decision](https://github.com/KeeprDigital/card-keepr/issues/210#issuecomment-5556048893).

Unresolved intake remains an Entity Proposal outside published data. Source rules
can admit sufficiently established real entities; the owner can record explicit
exceptions with evidence, but cannot waive required Game Profile structure or a
Printing's identified Card. Curated Revisions correct existing facts. Admission,
identity resolution and correction decisions do not publish a candidate.
[Admission decision](https://github.com/KeeprDigital/card-keepr/issues/211#issuecomment-5556519627).

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
