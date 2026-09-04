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
| `source_workflow_stalled` / `source_workflow_errored` / `source_workflow_terminated` / `source_workflow_unavailable` | The collection Workflow stopped driving the run; a host pacing wait against its persisted deadline or a durable Retry-After wait is never a stall. | Resume; a new Workflow Attempt is recorded. |
| `owner_requested` | The owner paused the collecting run with `source pause`. Nothing failed; the current Workflow Attempt was abandoned. | Resume (a new Workflow Attempt is recorded) or terminate. |

Genuine integrity failures (redirects, identity collisions, malformed
discovery, parser contract failures, completeness contradictions) remain
terminal and never pause. On the listing, detail, product, and surface
roles they fail the run; on the image role they fail that one request
(see below).

## Failed images never pause or fail a run

`source_transport_retries_exhausted` applies to the listing, detail,
product, and surface roles, where a missing response means missing
catalogue facts, and every terminal outcome on those roles fails the run.
Image requests follow a different transport policy: they get a longer
fetch bound (60 s instead of 30 s) and the same bounded retries, but any
failure of an image records that one Source Request as `failed` under a
class-specific code and collection continues. Storage (R2) retry
exhaustion still pauses the run for every role.

| Image `failure_code` | Meaning |
| --- | --- |
| `source_image_retries_exhausted` | The image's bounded transport retries ran out on recoverable failures (timeouts, network errors, 429 or 5xx responses). |
| `source_image_not_found` | The Official Source answered 404 or 410: the file is gone. |
| `source_image_rejected` | The Official Source answered another non-retryable status (for example 400 or 403). |
| `source_image_redirected` | The Official Source answered with a redirect. Redirects are recorded, never followed: following one would silently change the evidence origin. |
| `source_image_revalidation_rejected` | A 304 response did not match the retained Source Snapshot's validator and representation. |
| `source_image_body_contract` | The response body violated its own contract (for example an invalid or contradicted `content-length`) on every bounded attempt. |

None of these codes pauses or fails the run. The run completes collection,
parses, and reconciles with the gap recorded explicitly: the Catalogue
Candidate carries one `printing_image_unavailable` warning per failed image
(request reference, source URL, Source Lineage, failure code), the affected
Printing is published without that Printing Image, and nothing blocks
approval. Inspect the gap with:

```sh
npm run keepr -- source show --run-id RUN_ID --json
```

The `collection.failed_images` block reports the exact `count` and a list
bounded to the first `detail_limit` entries (`truncated` says whether the
list is bounded), each with the safe request reference, hostname, failure
code, and attempt count. The text form prints one `Failed images:` line.
Nothing here needs an owner action on the run itself: start a later
Ingestion Run to collect the missing images once the Official Source's image
path recovers.

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
A paused run that should continue after all is resumed under a
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

Each recorded Workflow Attempt also reports `last_progress_at`, `last_step_name`,
and `last_phase` (`started`, `completed`, or `failed`). These facts come from
executed durable callbacks; rereading status or replaying a cached step does not
refresh them. The run's stall clock includes productive collection work and
persisted pacing/retry deadlines. Parent barrier polling cannot conceal a child
that stopped making progress. A transient Workflow API outage does not trigger
recovery: retry the administration request once the control plane is available.


## Resume waits for superseded Workflow Attempts

Before reopening collection, `source resume` retries termination and inspects
all parent and hostname-shard attempts current at the pause. Only confirmed
`terminated`, `errored`, `complete`, or absent instances permit resume. If an
instance remains live or its status cannot be read, the command reports
`collection_workflow_supersession_pending` (HTTP 409), names the unsettled
identities, and keeps the run paused. Retry the same resume after the control
plane recovers; this refusal consumes no Workflow Attempt or retry generation.

Independently of that control-plane check, every collection Workflow callback
and capture admission checks its immutable parent identity and its current
hostname-shard attempt against D1. An old sleeper cannot regain permission
when the run returns to `collecting`: it settles as superseded and leaves
pending requests and retained evidence for the new attempt. The replacement
parent gives each inherited shard a new attempt identity. Audit history and
capture-operation identities remain append-only and idempotent.
