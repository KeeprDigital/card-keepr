# Reconciliation continuation

Reconciliation progress lives in D1. Workflow history contains bounded cursor or
terminal references; it is not the candidate store. Inspect the reconciliation
status and partition routes to see preparation independently of a Workflow's
status.

Each reconciliation Workflow instance executes at most ten preparation steps.
Each step has three retries. This reserves at most 4,000 service calls for
preparation at the 100-call work-unit target, leaving room within the 5,000-call
shard target for dispatch, failure handling and notification. Work-unit resource
enforcement is separate from this orchestration bound.

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
generation and an action idempotency key. A paused candidate retains its game
slot. Abandonment fences it before releasing that slot; another intent creates a
new candidate from the same retained collection.

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
An occupied game slot returns a blocked result while other games still dispatch.
Native creation releases the completed collection's reservation atomically after
pinning. Preparation failure leaves source collection evidence intact.

List a collection's native preparations through
`GET /v1/ingestion-runs/:run/game-candidates?after=...` or
`keepr game-candidate list --run-id ...`. Pages contain at most 100 compact
candidate headers and a continuation cursor, including retained failed and
abandoned candidates. Inspect each candidate's durable progress directly; no
Workflow platform access is required.

Runtime resource enforcement and the remaining acceptance checks are still
required for #225 before downstream #226/#227 proceed. Those issues must consume
the sealed candidate and its retained preparation ownership through this protocol.

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

The resource regression probes actual D1 and R2 calls through the real Workflow
for high-degree matches and distinct numbered Cards with equal facts. This is
not yet proof of callback-wide CPU, memory, stream, or Workflow service-call
limits; those remain part of final resource acceptance.

Large text fields share bounded write batches across one retained record, with
at most 16 chunks and 512000 content bytes per batch. Hydration reads at most
two pages together; each page has at most 16 chunks and 512000 content bytes,
so their combined fetch stays below 1 MiB. Every chunk receipt and completed
text digest is still checked. The curated field-target regression retains
32 large trait strings plus the owner's corrected name and verifies their
retained candidate references while measuring every callback's D1/R2 calls.
