# Verify publication artifacts for one game

Publication preparation consumes a sealed native Catalogue Candidate. It does
not approve the candidate, change a published pointer, or release its per-game
slot. Candidate inspection readiness (#226) and verified publication artifacts
(#227) are independent prerequisites for the atomic publication work (#228).

Start once with the owner CLI. `generation` and `manifest-digest` come from the
candidate; a new publication preparation starts at sequence zero.

```sh
keepr publication-preparation start --candidate-id CANDIDATE \
  --manifest-digest SHA256 --generation 0 --sequence 0 \
  --idempotency-key INTENT --json
keepr publication-preparation status --candidate-id CANDIDATE --json
keepr publication-preparation artifacts --candidate-id CANDIDATE --json
```

The production Reconciliation Workflow binding runs an explicitly identified
publication-preparation payload. Each shard performs at most sixteen durable
units and dispatches a deterministic successor. The request and CLI can finish
while work continues. There is no test-environment dispatch branch. Repeating
the exact start resolves its retained action and deterministic Workflow identity.

The status contract is `card-keepr-publication-preparation@1`. `candidate_id`
identifies the sealed candidate and its one-to-one publication ledger;
`preparation_id` always identifies the originating Reconciliation Operation.
`ingestion_run_id` is the actual source collection, never an artifact owner.
The ledger pins the candidate manifest and generation; its status also reports
the game's exact predecessor and original seven-day deadline. It retains phase,
sequence, cursor, artifact count, failures, and the verified root digest.
Artifact and action receipts belong to this candidate through foreign keys.

## Bounded stages and immutable artifacts

1. **Images:** verify the complete ordered candidate manifest, including
   administrative partition kinds that are excluded from publication. Verify
   one retained content-addressed Printing Image at a time by streaming its
   exact bytes. Reconciliation has already retained these images in the private
   image bucket, so promotion reuses their objects. Neither possession of an
   object nor a preparation receipt makes an image consumer-visible.
2. **Exports:** produce content-addressed per-game fact components. Metadata
   components contain at most one record and 512 KiB. Large text remains a
   separate path reference; each bounded text chunk is promoted and its full
   digest/length is verified with a durable incremental hash. Administrative
   evidence fields remain out of the fact components. These component envelopes
   are the native preparation format, not the legacy monolithic export package.
3. **Projections:** retain immutable query/search batches, indexed private entity
   documents, and field-separated trigram search chunks. Large searchable text
   is chunked with overlap rather than combined into a whole-card search buffer.
   Query documents and indexes are candidate-owned, outside published query
   revision tables. The owner can inspect them at
   `GET /v1/game-candidates/CANDIDATE/publication-preparation/query?kind=cards&q=TEXT`.
4. **Composition:** write immutable nodes with at most 32 child references and
   16 KiB. Higher levels refer to lower levels, so neither the root nor a
   transaction contains every catalogue artifact. The final game root binds the
   candidate, originating preparation, manifest, game, predecessor and deadline.

Components use content-addressed keys independent of candidate identity, so
unchanged/carry-forward facts reuse verified objects. A new game root binds the
new candidate without rewriting those components. The owner-only
`POST /v1/publication-compositions` accepts `candidate_ids` for at most one
verified candidate per game (four games maximum), verifies their roots, and
retains a small immutable composition of those references. Unrelated games'
components are reused. This prepares references only; #228 owns choosing and
atomically publishing a consistent composition and checking backup/approval.

Each successful unit atomically commits its cursor, immutable output receipts,
query writes and exact response. D1 transactions stay below the 1 MiB work target;
metadata reads stay within 512 KiB partitions. Image verification streams at
most one declared image, with a 20 MiB per-object emergency guard. Search units
bound raw text and normalized scalar work; composition uses at most 32 rows.
The existing Workflow callback guard enforces 100 service calls and four open
R2 bodies. Durable shard reservations charge that whole callback allowance
before execution and cap a shard at 40 attempts, including lost-output replay.
These are resource guards, not throughput or real-source capacity measurements.

## Retry, interruption and fencing

`POST /v1/game-candidates/CANDIDATE/publication-preparation` is the same bounded
advancement primitive used by the Workflow. It accepts `manifest_digest`,
`generation`, `sequence`, and `idempotency_key`. It is useful for controlled
recovery and injected-failure tests; the normal CLI start drives automatically.
An exact replay returns the original response without doing more work, even if
later requests have progressed. Inspect current status separately.

An object PUT can succeed before verification or the D1 transaction fails. Such
partial staging has no receipt and no visible query data. The next attempt
verifies/reuses the existing immutable object. It never overwrites a conflicting
object. Three failed storage units retain `publication_retry_exhausted` and
`retry_paused`; the cursor and verified work survive. Resume with current status:

```sh
keepr publication-preparation resume --candidate-id CANDIDATE \
  --manifest-digest SHA256 --generation 0 --sequence SEQUENCE \
  --idempotency-key RESUME --json
```

Resume starts another bounded retry allowance at the retained cursor and cannot
renew the original deadline. Missing/corrupt image, partition, text or manifest
failures are terminal with distinct codes; they are not transient retry pauses.
A Workflow budget pause is likewise explicit. If the control plane loses or
errors a Workflow outside a work unit, a fresh start at the current sequence
opens a deterministic successor without deleting old work. Repeated exact starts
observe the original identity; they do not silently restart an errored instance.

Every artifact-committing transaction rechecks the sealed candidate's owned slot,
generation, manifest, expected game head, current deadline, and global recovery
health. A writer superseded by abandonment cannot commit artifacts. Terminal
Workflow fence bookkeeping updates only its own old publication ledger with a
sequence guard. Verified status records a historical verification; it does not
waive #228's fresh deadline, ownership, predecessor, inspection, approval or
backup checks. Candidate generation/state and source collection state are not
advanced by this preparation.

## Validation evidence

The focused Worker tests use synthetic source fixtures and explicitly injected
R2 failures. They cover bounded stages, large text, lost responses, partial
staging, exhausted retry/resume, corruption, stale/deadline/abandonment fences,
private query/search data and independently verified game references. The native
CLI/API acceptance test uses synthetic publisher responses with the shipped
production Workflows and no legacy publication harness, and checks that prepared
Cards and images remain unavailable to authenticated Catalogue Consumers.
These tests do not establish real-source completeness, #233 representative
CPU/memory capacity, atomic publication, backup restore, or production readiness.
