# Proposed formalized implementation contracts

Contract family: `card-keepr-implementation-contracts@1`

This family is the proposed answer to “Formalize the implementation contracts.”
Normative words such as **must**, **must not**, and **exactly** are acceptance
requirements. Internal D1 tables, repository modules, and equivalent internal
techniques remain implementation choices.

## Contract set

| Concern | Normative artifact |
| --- | --- |
| Authenticated read API | `openapi.json` and `schemas/api.schema.json` |
| Catalogue Export shape | `schemas/catalogue-export-manifest.schema.json` and `schemas/catalogue-export-record.schema.json` |
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
- Pull-request and `main` CI never mutate production. Only a serialized,
  manually dispatched production release workflow holds deployment credentials,
  and the guarded repository CLI is its entry point.

## Credential isolation

The five credential classes are distinct:

1. browser-visible API bearer traffic gate — API Worker only;
2. high-entropy ingestion administration key — ingestion Worker and owner CLI;
3. D1 export token — ingestion runtime, export operation only;
4. D1 disposable-verification token with Account D1 Edit — ingestion runtime
   only, never API Worker or deployment workflow; and
5. Cloudflare deployment token — manually dispatched release workflow only.

API and administration keys rotate through overlap and verification before the
old value is revoked. Single-holder Cloudflare tokens rotate by installing and
verifying the replacement in their owning boundary before revocation. Secret
values never appear in CLI arguments, output, logs, source, snapshots, or
diagnostic bundles.

## Acceptance scenarios

The executable state machine must demonstrate:

1. a candidate can be inspected, digest-bound approved, published with its
   verified Catalogue Export, and followed by verified backup recovery;
2. seven days without approval expires the candidate and releases the lock;
3. stale candidate digests and stale expected revisions fail closed;
4. an active Ingestion Run or degraded recovery blocks a release or approval;
5. recovery blocks mutation until validation and explicit acceptance; and
6. credential rotation cannot revoke the old value before replacement
   verification.

Acceptance means these artifacts feel correct as a single handoff and no
machine-readable field, route, serialization rule, command guard, or transition
needs a product or architecture decision during implementation.
