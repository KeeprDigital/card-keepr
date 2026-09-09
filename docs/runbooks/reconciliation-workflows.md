# Reconciliation continuation

Reconciliation progress lives in D1. Workflow history contains bounded cursor or
terminal references; it is not the candidate store. Inspect the reconciliation
status and partition routes to see preparation independently of a Workflow's
status.

Each reconciliation Workflow instance executes at most 40 preparation steps.
Before every actual attempt, a guarded D1 reservation charges 100 service calls
to that preparation, generation and shard. Reservations cannot decrease and
survive a lost callback result or an actual Workflow restart. Once its 4,500-call
work allowance is exhausted, the instance dispatches a successor. A lost
reservation response conservatively consumes capacity even if work never began.

The other 500 calls cover control steps. Native initialization, dispatch-state
inspection, successor retention, dispatch, failure finalization and notification
have fixed paths of fewer than 20 service calls each. Their four-attempt retry
allowances total at most 480 calls; the remainder covers refused work
reservations. The normal path is much smaller: successor dispatch uses at most
three Workflow binding calls per attempt. Work-unit resource enforcement remains
separate from this orchestration bound.

Before dispatching a successor, the current instance retains its exact parameters
and deterministic identity in the `workflow_dispatch:<generation>` checkpoint.
The identity binds the preparation ID, generation and shard ordinal. The legacy
adapter uses its retained run key as the preparation ID.
Dispatch retries recover that same identity through the Workflow driver. An
instance that has dispatched its successor returns; it never polls the chain.

The root is a native reconciliation Workflow, or the collection parent for the
legacy single-game adapter. It waits once for the `reconciliation-terminal` event. The final shard
sends only the terminal reference to that root. The wait uses the operation's
original deadline. Restarting a root reads retained dispatch progress, while a
sealed operation immediately returns its retained digest reference. A Workflow
restart does not extend the candidate deadline or clear D1 checkpoints.

Owner pause, resume and abandon remain generation-fenced administration actions.
A resumed generation uses a new dispatch namespace. Do not restart an old
generation as a substitute for the owner resume action.

Independent owner operations start with `POST /v1/game-candidates`, supplying the
retained `ingestion_run_id`, `supported_game`, `expected_game_revision_id`, and an
`idempotency_key`. Inspect the returned candidate ID directly, including its
`progress`, `inputs`, and `partitions` pages. Large text remains in the bounded
`text/:digest/:ordinal` chunks referenced by each partition. Collection provenance remains the real Ingestion
Run ID; preparation artifacts and Workflow dispatch belong to `preparation_id`.
The `pause`, `resume`, and `abandon` candidate routes accept the inspected
generation and an action idempotency key. A paused or sealed candidate retains its game
slot. The owner can abandon either state, including an expired sealed candidate.
Abandonment increments its generation before releasing only its own slot; another
intent creates a new candidate from the same retained collection. The original
manifest, evidence and deadline remain inspectable. Every action is atomically
fenced while shared-database recovery is blocked.

Native Workflow terminal references use
`card-keepr-game-reconciliation-workflow-result@1` and identify both the source
run and preparation. Legacy references keep their existing contract.

Follow-on preparation stages should return durable progress at each bounded work
unit and use this continuation protocol. They must not put an unbounded loop into
the collection parent, wait on every descendant, or send candidate records through
Workflow parameters or events.

The collection parent dispatches one native Workflow per game for multi-game
collections and for single-game adapters with a retained `officialSourceContract`.
These raw production source contracts therefore use native preparation. The
single-game registration contract without an Official Source Contract retains
legacy run/candidate compatibility; this is a contract distinction, independent
of the environment or adapter name. Its existing large-candidate parent/restart
contract remains supported. Native preparation is separately verified with the
same existing large printed-text fixture.

Each native dispatch uses one durable callback. It retains the original request
and game predecessor before dispatch, and a parent restart reuses that identity.
The parent returns bounded preparation identities without waiting for completion.
An occupied game slot or pending correction reconfirmation returns a bounded
blocked result while other games still dispatch.
Native creation releases the completed collection's reservation atomically after
pinning. Preparation failure leaves source collection evidence intact.

List a collection's native preparations through
`GET /v1/ingestion-runs/:run/game-candidates?after=...` or
`keepr game-candidate list --run-id ...`. Pages contain at most 100 compact
candidate headers and a continuation cursor, including retained failed and
abandoned candidates. Inspect each candidate's durable progress directly; no
Workflow platform access is required.

Downstream #226/#227 must consume the sealed candidate and its retained
preparation ownership through this protocol.

Native mapping evidence is retained in `reconciliation_source_mappings`, keyed by
preparation, entity, and Source Observation. It keeps the real collection ID as
provenance. Owner identity inspection accepts `preparation_id` to page that
preparation's mappings and show its candidate state. These staged rows do not
enter the legacy canonical mapping index, even when the source collection was
already published. Native publication integration (#226/#227) must use the
preparation's retained mapping evidence and gate any published mapping projection
on that candidate's publication; source collection state is not publication
authority for a native candidate.

Preparation rejects a genuine identity work unit with
`reconciliation_capacity_exceeded` when it exceeds eight candidate references,
eight records in one Printing match group, 512 KiB of match metadata, or eight
nested matching visits for one observation. These are local identity-work
limits, not a cap on the number of Cards or Printings in a game. Numbered Card
confirmation searches an indexed unnumbered-facts subset so unrelated numbered
identities do not consume that allowance. Unnumbered observations receive a
separate reduction callback. Native capacity outcomes retain their original
preparation identity and can be replayed.

Every actual reconciliation callback, including retries and control callbacks,
uses a resource guard covering D1, R2, and Workflow binding calls. It refuses
the 101st call and fifth open R2 body. Callback cleanup cancels unconsumed
bodies. Exhaustion pauses retryably as a storage failure; it cannot masquerade
as invalid source data. Native resource probes also count actual calls outside
the guard.

The ingestion Worker config sets `limits.cpu_ms` to 10000 and
`limits.subrequests` to 5000. These platform limits apply to the deployed Worker;
Wrangler local development does not enforce CPU limits. Local tests therefore
do not establish remote CPU or peak resident-memory performance.

Large text fields share bounded write batches across one retained record, with
at most 16 chunks and 512000 content bytes per batch. Hydration reads at most
two pages together; each page has at most 16 chunks and 512000 content bytes,
so their combined fetch stays below 1 MiB. Every chunk receipt and completed
text digest is still checked. The curated field-target regression retains
32 large trait strings plus the owner's corrected name and verifies their
retained candidate references while measuring every callback's D1/R2 calls.

Canonical hashing and legacy payload preparation checkpoint after 128 records or
reaching 512 KiB of canonical bytes. Source parsing, candidate partitioning and
entity scopes use groups of at most 32 records with their byte thresholds intact.
Normalization weights image work and source bytes; Product input groups also
bound their number of effects. One Product input exceeding 24 effects for a
fresh candidate, or eight when comparing a predecessor, returns an explicit
capacity outcome. Product identity matching allows eight references and 16
nested visits. Card Errata work allows eight inline or matching Errata and
512000 bytes. These bounds do not cap a game's total entities.

A Card, its small identity reference, and its local comparison facts share one
guarded transaction. The last
verified text-free write, at most 32 KiB, may satisfy a read in that observation;
continuations reopen and verify retained storage. New identity allocation and
normalization use insert receipts directly, reading the existing immutable row
when an insert loses a race or replays.

Compatibility staging groups at most 32 plans, with at most two retained rows
per plan, and keeps its 512 KiB byte threshold. Checkpoint inserts return their
verified receipt directly; replay conflicts still read and verify the exact row.
Completed catalogue digests return their retained receipt before reopening
semantic sources. Canonical key ordering uses direct ASCII comparison where
UTF-16 and UTF-8 ordering agree, retaining NFC byte comparison for other keys.

The sealed input records whether normalized Card Errata exist. The first official
reduction checkpoint also pins which selected games have published Card identities,
including withdrawn identities. Proven absence avoids redundant per-Card lookups;
older receipts without these flags keep the lookups. The same head fence protects
these observations and the prepared writes.

A fresh candidate with neither a predecessor candidate nor admitted entities
skips provenance restoration, because normalized source entities have no earlier
curated effects. Pinned correction comparison, application, and composed-candidate
validation still run. Later callbacks batch fixed checkpoint reads in groups of
six, each checkpoint at most 64 KiB. The read window belongs to that callback's
fresh guarded store; checkpoint writes refresh it after receipt verification.

The separate native 1001-Product probe measures callback D1/R2 calls and elapsed
preparation time. The original four scale fixtures and deadlines remain the
performance acceptance gates; these optimizations alone do not establish them.

Source tokens are limited to 4 MiB of UTF-8 bytes and characters, 16384 structural
punctuation tokens, and depth 128 before parsing. Large quoted text remains
supported; dense or deeply nested single records return explicit capacity.

Legacy payload construction reuses immutable canonical byte chunks retained
during the candidate hash. The completed hash checkpoint pins their count; each
chunk is verified again before compatibility staging. Old checkpoints without
that receipt use the resumable canonical reader. Sorted record readers retain
at most four verified metadata batches per sorter and clone envelopes before
hydration; cached batches never contain hydrated text.

## Working-set argument and capacity proof boundary

Preparation holds bounded pages and a fixed number of current records; its live
working set does not grow with the number of entities in a game. Reducer indexes
seek by immutable keys instead of materializing the index. Continuations discard
callback-local state and reopen verified receipts. Images remain R2 references.

| Work | Retained live content bound |
| --- | --- |
| Source parsing | One token, at most 4 MiB, plus bounded source chunks; structure/depth limits bound object amplification. |
| Metadata reads | Normally at most 512 KiB per page; text hydration fetches two 512000-byte pages. No metadata fetch exceeds 1 MiB or 500 rows. |
| Identity work | Eight match references and one hydrated match at a time; high-degree records fail explicitly. |
| Canonical sorting | Four current comparison heads, each at most 2 MiB canonical text, and an output group bounded by 512000 bytes or one oversized head. Output references the existing heads. At most four 512 KiB metadata receipts per sorter; hydration is never cached. |
| Hashing and partitioning | A resumable record/chunk cursor, bounded canonical chunks, and at most 512 KiB of pending payload content. |
| Callback checkpoint window | At most 16 fixed phase keys, each no larger than 64 KiB. Writes replace verified cached receipts. |

These bounds leave room within the 64 MiB working-set target for UTF-16 strings,
decoded envelopes, hash state, and current serialized output. They are an
algorithmic bound argument, not a measured heap census. The configured CPU cap
and enforced service-call, open-stream and shard quotas accompany these bounds.
Representative-concurrency peak memory/CPU measurements, real-source capacity,
and the complete usable-capacity/fault campaign belong to #233 after its
prerequisites #230/#231/#232. Passing synthetic tests here does not establish
those later measurements or production throughput.
