# Runbook: paused Official Source collection

An evidence-backed Ingestion Run pauses instead of failing when collection
cannot safely continue without the owner. Nothing retained is lost: every
Source Snapshot, Source Observation Set, pending Source Request, capture
operation, and Workflow Attempt survives, the run keeps the single active-run
reservation and its expected Catalogue Revision, and publication stays
blocked until collection completes. A paused run can only resume or be
terminated; it can never parse, reconcile, be approved, or publish.

## Inspect

```sh
npm run keepr -- source show --run-id RUN_ID
npm run keepr -- source show --run-id RUN_ID --json
```

Both forms carry the same material facts. The `collection` block reports:

- `state`, `pause_reason`, `paused_at`, `last_progress_at`, and the expected
  Catalogue Revision the run is bound to.
- `capacity` per Source Lineage: generation, limit, used, remaining, and the
  capacity the rejected batch requires when the run is capacity-paused.
- `requests` grouped by Source Lineage, request role, and lifecycle state.
- `evidence`: Source Snapshot count, retained byte total, Source Observation
  Set count, fetch-attempt and retry counts, and the latest safe failure. The
  `snapshots`, `observation_sets`, and `diagnostics` lists are bounded to the
  newest `detail_limit` entries; the counts are exact.
- `progress.current_request`: the safe request reference and hostname most
  recently worked on. No request headers, credentials, or bodies appear.
- `pacing`: the configured per-host pacing and every host with open work.
- `estimate`: an advisory minimum remaining duration derived from pending
  requests per host and the pacing interval. It never drives lifecycle
  decisions.
- `workflow`: every parent and hostname-shard Workflow Attempt with a safe
  status; exactly one attempt per scope is current.
- `actions`: the exact collection actions the lifecycle admits right now
  (`pause` while collecting; `resume`, `extend_capacity`, `terminate`, or
  `retry` otherwise); approval and rejection stay on the run document.

## Pause reasons

| `pause_reason` | Meaning | Action |
| --- | --- | --- |
| `source_request_capacity_exhausted` | Admitting a discovered batch would exceed the Source Adapter Version's Request Capacity. Nothing was inserted or failed. | Extend capacity, then resume. |
| `source_transport_retries_exhausted` | One Source Request exhausted its bounded transport retries on a recoverable failure. | Resume once the Official Source recovers. |
| `source_storage_retries_exhausted` | One Source Request exhausted its bounded R2 persistence retries. | Resume once storage recovers. |
| `source_workflow_stalled` / `source_workflow_errored` / `source_workflow_terminated` / `source_workflow_unavailable` | The collection Workflow stopped driving the run; a durable pacing sleep or Retry-After wait is never a stall. | Resume; a new Workflow Attempt is recorded. |
| `owner_requested` | The owner paused the collecting run with `source pause`. Nothing failed; the current Workflow Attempt was abandoned. | Resume (a new Workflow Attempt is recorded) or terminate. |

Genuine integrity failures (redirects, identity collisions, malformed
discovery, parser contract failures, completeness contradictions) remain
terminal and never pause.

## Stop a collecting run

Stopping is two owner actions: pause, then terminate. Termination alone is
refused while the collection Workflow is live; it accepts a collecting run
only when the Workflow is already deterministically observed dead.

```sh
npm run keepr -- source pause \
  --run-id RUN_ID \
  --idempotency-key pause_RUN_ID \
  --json
npm run keepr -- source terminate \
  --run-id RUN_ID \
  --idempotency-key terminate_RUN_ID \
  --json
```

`source pause` is an idempotent Workflow Pause with the reason
`owner_requested`: the run's state fences every durable collection step,
the parent and hostname-shard Workflow Attempts current at the pause are
terminated best-effort, and the run reports `resume` and `terminate` as its
actions. Replaying the same key returns the original result; pausing a run
that is not collecting is refused with `ingestion_run_not_collecting`, a
key reused for another request with `idempotency_conflict`, and a pause
that lost a race with a concurrent resume with `collection_pause_conflict`.
A paused run that should continue after all is resumed as usual under a
new Workflow Attempt.

Terminating Workflow instances directly (the Cloudflare dashboard, or
`wrangler workflows instances terminate`) is not a supported way to stop a
run: it leaves the run collecting until its dead Workflow is classified,
and the wrangler commands have built the API path wrong or failed on the
request body. Pause the run instead.

## Extend capacity

Read `capacity[].request_capacity`, `capacity_generation`, and
`required_capacity` from `source show`, then:

```sh
npm run keepr -- source capacity extend \
  --run-id RUN_ID \
  --expected-capacity CURRENT_CAPACITY \
  --expected-generation CURRENT_GENERATION \
  --capacity NEW_ABSOLUTE_CAPACITY \
  --idempotency-key extend_RUN_ID_1 \
  --json
```

The extension is a compare-and-set on the current capacity and generation:
a stale expectation, an unchanged or decreased capacity, or a value at or
above the global emergency ceiling (25,000) is refused explicitly. Replaying
the same key returns the original result. Extension never resumes the run.

## Resume

```sh
npm run keepr -- source resume --run-id RUN_ID --json
```

Resume moves the same Ingestion Run back to collecting under a new Workflow
Attempt. Observed requests are never fetched again, captured requests resume
from their retained Source Snapshots without a network request, a
capacity-paused parent derives its overflow batch again from retained
evidence, and retry-exhausted requests reopen under their next bounded retry
generation. Resume is idempotent: replays reacquire the same attempt.

## Terminate

```sh
npm run keepr -- source terminate \
  --run-id RUN_ID \
  --idempotency-key terminate_RUN_ID \
  --json
```

Termination is the only path from paused to terminal. It records the owner
decision with the stable reason `ingestion_run_terminated`, retains every
evidence object and pause record, fences late Workflow work, and releases
the active-run reservation so a new Ingestion Run can start. Only a paused
run can be terminated; concurrent resume, extension, and termination
requests resolve as explicit state conflicts. A terminated run cannot
resume, extend capacity, parse, reconcile, be approved, or publish; its
evidence remains auditable and it can be retried as a new linked run with
`source retry`.

## Exit codes

The CLI keeps its established conventions: `0` success, `2` usage error,
`7` for a conflict problem document (stale expectation, wrong state), and
problem documents in `--json` mode follow `card-keepr-cli-problem@1`.
