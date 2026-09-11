# Proposed formalized implementation contracts

> Historical proposal. Maintained API, export and administration documents
> now live in [contracts/](../../contracts/README.md). The filenames below
> describe the original handoff; the prototype state machine remains historical.

Contract family: `card-keepr-implementation-contracts@1.1`

This family is the proposed answer to “Formalize the implementation contracts.”
Normative words such as **must**, **must not**, and **exactly** are acceptance
requirements. Internal D1 tables, repository modules, and equivalent internal
techniques remain implementation choices.

## Contract set

| Concern | Normative artifact |
| --- | --- |
| Authenticated read API | `openapi.json` and `schemas/api.schema.json` |
| Catalogue Export shape | `schemas/catalogue-export-manifest-v5.schema.json` and `schemas/catalogue-export-record-v5.schema.json` |
| Catalogue Export bytes | `SERIALIZATION.md` |
| Owner administration | `ADMINISTRATION.md`, `schemas/administration.schema.json`, and `administration.mjs` |
| Game semantics and source mappings | `../v1-game-profiles-source-adapters/CONTRACT.md` and `contract.mjs` |

The Markdown files explain decisions, but machine-readable files define names,
types, requiredness, enumerations, and legal transitions. A contradiction is a
contract defect to resolve before implementation; prose does not silently
override a machine-readable artifact.

## Read API decisions

- Every operation is under `/v1`, read-only, and authenticated by the API
  bearer traffic gate. `OPTIONS` preflight is unauthenticated infrastructure
  behavior, not a catalogue operation.
- Credential proof orchestration and replay-nonce mutation belong to the
  ingestion Worker. API accepts a signed observation only through a private
  named service entrypoint, verifies the selected live secret through its
  normal bearer `GET /health` path, and signs the result without writing D1.
- Browser requests additionally require an exact environment-specific origin.
  Preflight permits `GET`, `HEAD`, and `OPTIONS` plus `Authorization`; actual
  responses expose `ETag` and `X-Catalogue-Revision` and send `Vary: Origin`.
  Valid bearer requests without `Origin` remain permitted for CLI and
  service-to-service Catalogue Consumers.
- Cards, Printings, Printing Images, Products, Catalogue Revisions, Catalogue
  Exports, Source Observations, Curated Revisions, Errata, and Legality Rules
  use opaque immutable Card Keepr identities.
- Collection order is fixed per route and every cursor pins route, normalized
  filters, ordering, page size, and Catalogue Revision. Any mismatch is
  `400 invalid_cursor`; an unavailable pinned revision is
  `409 cursor_revision_unavailable`.
- Successful JSON reads identify one Catalogue Revision in both
  `meta.catalogue_revision_id` and `X-Catalogue-Revision`. `/catalogue` may also
  advance freshness without a new Catalogue Revision and therefore has its own
  ETag.
- Provenance and disagreements are opt-in detail sidecars. An unresolved
  canonical value is `null`; the API never chooses an unaccepted candidate.
- Card, Printing, and Product representations expose the same required
  `lifecycle` object already fixed by Catalogue Export records:
  `first_revision_id`, `last_observed_revision_id`, and `withdrawn`. Collection
  and detail representations do not invent different lifecycle vocabulary.
- Product detail accepts `include=evidence,disagreements` with the same
  semantics as Card and Printing detail. Provenance keys are JSON Pointers into
  the exact revision-pinned response and may address nested Release facts.
  Unresolved Product or Release facts remain `null`, with candidate values in
  `disagreements` and supporting Source Observations or Curated Revisions in
  `included`.
- Every regional Release retains the Official Source's calendar precision and
  whether that observation is still `announced` or already `released`.
- `GET /legality-status` requires Card, date, and format. With `region`, it
  returns exactly one regional result. Without `region`, it returns every
  applicable regional result separately. Gundam accepts only `EN-ASIA` and
  `EN-US`; `EN-OCEANIA` yields `422 invalid_legality_region`. There is no
  synthetic Oceania Gundam Legality Status.
- Printing Image and Catalogue Export component bytes are authenticated,
  immutable, private-R2-backed streams supporting `GET`, `HEAD`, conditional
  requests, and byte ranges. They are never shared-public-cache responses.
- The later Catalogue Export decision supersedes only the earlier exclusion of
  bulk export. It adds the three routes in `openapi.json`; it does not add raw
  Source Snapshots or provenance bundles.
- A Catalogue Export package is host-independent: its manifest and records
  reference Printing Images and components by identifier, never by link, and
  `SERIALIZATION.md` declares the route templates a consumer applies to its own
  configured API base. Before Go-Live the one export schema major is edited in
  place (ADR 0008).
- A Catalogue Export in `deleting` or `deleted` state is absent from the export
  collection. Its known manifest and component URLs return `410
  catalogue_export_deleted`; a never-known Catalogue Revision remains `404
  not_found`.

## Guarded Catalogue Export deletion

- Deletion is a two-step owner maintenance operation: prepare an immutable
  15-minute plan, inspect its dependencies and exact R2 object set, then confirm
  against the plan digest. Preparation never makes bytes unavailable.
- The plan binds Catalogue Revision, manifest SHA-256, expected current
  Catalogue Revision, exact export-only object keys, their set digest,
  dependencies, and expiry. Any changed binding requires a new plan.
- The current Catalogue Revision's export is a blocking dependency and cannot
  be deleted. Every plan warns that owner-controlled Catalogue Consumers may
  retain the export and that authenticated URLs will return `410`.
- Confirmation additionally binds a deletion identity, idempotency key, and the
  exact typed Catalogue Revision identity. Non-interactive confirmation is
  allowed only with every binding. Ingestion and production release must be
  idle and recovery must be healthy at the atomic confirmation check.
- Confirmation immediately makes the export unavailable, then deletion removes
  and verifies only keys beneath
  `catalogue-exports/<catalogue_revision_id>/`. The manifest is removed last.
  A key outside that prefix is a hard contract failure.
- Partial platform failure leaves the export unavailable and the operation
  `failed`; retry targets the same object-set digest. Success creates a retained
  tombstone and immutable operation result. The same idempotency key and request
  replays that result; changed reuse fails closed.
- Source Snapshots, Source Observations, Curated Revisions, Ingestion Runs,
  Catalogue Revision records, D1 backups, Time Travel bookmarks, recovery
  exports, and deletion audit records are outside the deletable object set and
  must not be removed by this operation.

## Publication and recovery invariants

- Only one Ingestion Run is active globally. A run selects Supported Games;
  unselected game membership carries forward unchanged.
- A candidate is approvable only in `awaiting_approval`, before its seven-day
  deadline, with exact run identity, candidate digest, and expected current
  Catalogue Revision. Approval also requires verified recovery for the current
  revision. Every guard is checked atomically.
- Expiry is terminal, releases the global ingestion lock, and requires a fresh
  linked Ingestion Run. Rejecting, failing, or publishing is also terminal.
  Retrying never mutates a terminal run.
- Approval begins publication. Candidate Catalogue Data, a verified Catalogue
  Export, and the current-revision pointer become visible together. Any export
  generation or verification failure terminally fails the unpublished run.
- Publication releases the ingestion lock and makes recovery `degraded` until
  a D1 export has been restored into a disposable database and verified. A new
  run may collect while recovery is degraded, but no later candidate may be
  approved.
- Ingestion and deployment are blocked throughout a recovery operation.
  Mutation reopens only after restored state passes the agreed integrity and API
  checks and the owner explicitly accepts it.
- Pull-request and `main` CI never mutate production. Only the serialized,
  manually dispatched `.github/workflows/production-release.yml` workflow
  holds deployment credentials and deploys both production Workers, and the
  guarded repository CLI is its entry point.

## Credential isolation

The five credential classes are distinct:

1. browser-visible API bearer traffic gate — API Worker only;
2. high-entropy ingestion administration key — ingestion Worker and owner CLI;
3. D1 export token — ingestion runtime, export operation only;
4. D1 disposable-verification token with Account D1 Write — ingestion runtime
   only, never API Worker or deployment workflow; and
5. Cloudflare deployment token — manually dispatched release workflow only.

API and administration keys rotate through overlap and verification before the
old value is revoked. Single-holder Cloudflare tokens rotate by installing and
verifying the replacement in their owning boundary before revocation. Secret
values never appear in CLI arguments, output, logs, source, snapshots, or
diagnostic bundles.

Runtime bearer authentication requires the presented value to match a secret
currently bound to the owning Worker. Catalogue rotation state can explicitly
deny an `old_revoked` value, but it cannot keep a provider-removed binding
alive; deletion therefore takes effect before an interrupted finalization is
reconciled.

The ingestion Worker is the sole public consumer-proof mutation boundary. It
consumes each signed request nonce before dispatching to the owning consumer.
API bearer proof dispatch uses a Worker service binding and a harmless
authenticated health observation; API's default router exposes no proof route
and performs no consumer-proof D1 write.

## Acceptance scenarios

The executable state machine must demonstrate:

1. a candidate can be inspected, digest-bound approved, published with its
   verified Catalogue Export, and followed by verified backup recovery;
2. seven days without approval expires the candidate and releases the lock;
3. stale candidate digests and stale expected revisions fail closed;
4. an active Ingestion Run or degraded recovery blocks a release or approval;
5. recovery blocks mutation until validation and explicit acceptance; and
6. credential rotation cannot revoke the old value before replacement
   verification;
7. the current Catalogue Export is a blocking deletion dependency;
8. stale digests, stale current revisions, changed plans, and missing exact
   confirmation fail closed without hiding an export;
9. a confirmed older export becomes unavailable, deletes only its bound object
   set, returns a stable replay result, and preserves audit and recovery state;
   and
10. a partial deletion failure remains unavailable and retries only the same
    exact object-set digest.

Acceptance means these artifacts feel correct as a single handoff and no
machine-readable field, route, serialization rule, command guard, or transition
needs a product or architecture decision during implementation.
