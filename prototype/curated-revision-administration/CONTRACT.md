# Proposed Curated Revision administration contract

Contract: `card-keepr-curated-revisions@1`

This contract extends the accepted `card-keepr-administration@1` family. It
does not change the meaning of a Curated Revision: an immutable owner-authored
correction or supplement applied exceptionally after Official Source
reconciliation while preserving both source evidence and its own provenance.

## Boundary

V1 Curated Revisions may:

- assert a canonical field value on an existing Card, Printing, Product,
  Release, Distribution Context, Erratum, or Legality Rule; or
- assert that one canonical relationship is present or absent.

They may not create or delete canonical entities; change opaque or natural
identity; modify Source Snapshots, Source Observations, Ingestion Runs, audit
history, or provenance; invent a new Game Profile field; or bypass a
hard-failure invariant. A model or adapter change is required when the desired
assertion cannot be represented by the selected shared schema or Game Profile.

Every proposal contains:

- one Supported Game and one canonical target;
- one typed field or relationship assertion;
- a non-empty owner rationale;
- at least one supporting evidence reference;
- an optional closed-open effective interval;
- the digest of the Official Source value or absence the owner reviewed; and
- for supersession, the exact prior Curated Revision identity.

Source Observation evidence uses an opaque Source Observation identity. Other
owner evidence uses a URI plus a content digest; it remains Curated Revision
provenance and never becomes an Official Source.

The server derives the author from the administration credential, assigns the
opaque identity and creation timestamp, validates the proposal against the
schema pinned by the expected current Catalogue Revision, and records the
canonical proposal digest. Proposal bodies are supplied by file or stdin, never
as command-line JSON.

## Immutability and lifecycle

The Curated Revision content never changes. Lifecycle is an append-only event
stream with a derived current status:

```text
authored → active
active → superseded | retired | reconfirmation_required
reconfirmation_required → active | superseded | retired
```

- `reaffirmed` is an immutable event that returns an unchanged assertion to
  `active` after the owner accepts the exact newly observed source value.
- `superseded` atomically activates a new immutable Curated Revision and makes
  the old one inapplicable. Changing a target, assertion, interval, rationale,
  or evidence always uses supersession.
- `retired` makes the assertion inapplicable without deleting it.
- No event or Curated Revision is edited or deleted.

Only one active Curated Revision may apply to the same target at the same point
in an effective interval. Overlap fails with
`curated_revision_target_conflict`; a replacement must use supersession.

## Reconciliation and source change

An Ingestion Run pins the ordered identities and digest of all active Curated
Revisions applicable to its selected Supported Games when it starts. Later
administration cannot change that set because Curated Revision mutation is
blocked while any Ingestion Run is active.

After normal Official Source reconciliation, the run compares each pinned
revision's last owner-reviewed source-value digest with the newly reconciled
source value or absence at the same target:

- unchanged source evidence: apply the assertion, attach `curated` evidence,
  and include the effect in the candidate diff;
- changed source evidence: append a `source_change_detected` event, derive
  `reconfirmation_required`, terminally fail the whole Ingestion Run with
  `curated_revision_reconfirmation_required`, and preserve the conflict,
  Source Observations, and failed-run diagnostics.

Another run selecting that Supported Game cannot start until the owner binds
one of `reaffirm`, `supersede`, or `retire` to the exact conflict digest.
Runs selecting only unaffected Supported Games remain allowed.

Reaffirmation updates only the owner-reviewed source baseline in its immutable
lifecycle event. Supersession records the new assertion and baseline on a new
Curated Revision. Retirement removes the exceptional assertion from later
runs. The owner then starts a fresh linked Ingestion Run; a failed candidate is
never rewritten.

## Owner API

The ingestion Worker exposes these administration-key-authenticated operations:

| Method and path | Meaning |
| --- | --- |
| `POST /admin/v1/curated-revisions/validate` | Read-only structural and semantic validation against an explicit Catalogue Revision |
| `GET /admin/v1/curated-revisions` | List by Supported Game, target, or derived status |
| `GET /admin/v1/curated-revisions/{id}` | Inspect immutable content, lifecycle events, effective status, and conflicts |
| `POST /admin/v1/curated-revisions` | Author and activate one validated Curated Revision |
| `POST /admin/v1/curated-revisions/{id}/reaffirm` | Accept the exact pending source-change conflict without changing the assertion |
| `POST /admin/v1/curated-revisions/{id}/supersede` | Atomically retire applicability of the old assertion and activate a new immutable one |
| `POST /admin/v1/curated-revisions/{id}/retire` | Make the assertion inapplicable while retaining all history |

There is no `PATCH` or `DELETE`.

Every mutation requires:

- `environment: production`;
- exact expected current Catalogue Revision;
- an idempotency key;
- no active Ingestion Run or production release;
- recovery health other than `blocked`;
- for an existing Curated Revision, its expected lifecycle event version;
- for a pending source conflict, its exact conflict digest; and
- for authoring or supersession, the canonical proposal digest.

Identical idempotency retries return the original outcome. Reusing a key for a
different request returns `idempotency_conflict`. All guards are checked in one
transaction with the lifecycle event append.

Successful mutation returns the Curated Revision identity, derived status,
event version, content digest, current Catalogue Revision, and operation
identity. Validation errors are `422`; stale or conflicting preconditions are
`409`; accepted asynchronous work is `202`. Problem bodies and CLI JSON use the
stable codes exercised by `curated-revisions.mjs`.

## Repository CLI

| CLI command | Mutation | Required bindings |
| --- | --- | --- |
| `keepr curated-revision validate` | no | proposal file/stdin and explicit Catalogue Revision |
| `keepr curated-revision list` | no | optional Supported Game, target, or status |
| `keepr curated-revision show` | no | Curated Revision identity |
| `keepr curated-revision create` | yes | proposal, proposal digest, expected current revision, idempotency key |
| `keepr curated-revision reaffirm` | yes | identity, event version, conflict digest, expected current revision, idempotency key |
| `keepr curated-revision supersede` | yes | old identity/event version, optional conflict digest, new proposal/digest, expected current revision, idempotency key |
| `keepr curated-revision retire` | yes | identity, event version, optional conflict digest, rationale, expected current revision, idempotency key |

Read-only commands never prompt. Mutations follow the accepted production
interaction contract: resolve and display the Cloudflare account, ingestion
Worker, D1, and R2 identities; display the exact target, Curated Revision and
conflict identities, content digests, and affected Supported Game; then require
confirmation. `--yes` requires every binding above.

The administration key comes only from a hidden prompt, keychain reference, or
stdin descriptor. It never appears in arguments, output, logs, lifecycle
events, or diagnostic bundles. Confirmation output shows a canonical summary
and digests, not raw secret material.

Existing exit codes remain unchanged: success `0`, usage `2`, declined `3`,
authentication `4`, authorization `5`, not found `6`, conflict/stale
precondition `7`, validation `8`, remote/platform failure `9`, and accepted but
non-terminal `10`.

## Acceptance scenarios

The executable reference must demonstrate:

1. authoring pins an immutable proposal and a run applies it after Official
   Source reconciliation;
2. a later source-value change fails the run and blocks the affected Supported
   Game until exact reaffirmation;
3. reaffirmation preserves the assertion and updates only the reviewed source
   baseline through an event;
4. supersession creates a new immutable revision and makes the prior one
   inapplicable;
5. retirement removes the assertion from later run snapshots without deleting
   history; and
6. stale revisions, mismatched conflict or content digests, overlapping targets,
   active ingestion/release, and blocked recovery all fail closed.
