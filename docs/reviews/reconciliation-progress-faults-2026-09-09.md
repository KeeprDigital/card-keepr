# Reconciliation recovery fixtures and bounded fault proof — 2026-09-09

Part of #274 and #276, under private launch tracker #216. No live operation was performed. This is a bounded subset of #276, not an exhaustive durable-boundary claim.

## Fixed implementation

Final code `e87612aa7157aef67976537f5ea8043d4f707e1a`, against the native owner provider `4705f498c0f2a53006d8ba0c8533980ea2ac2602`. The main two-file migration/fault diff was independently reviewed at `15bf19e3`; its six-line final oracle correction was separately reviewed from `15bf19e3` to `e87612aa`. Standards and Spec both found no actionable findings on each fixed slice.

Normal publication seeds use retained collection, native whole-candidate inspection and approval, and actual independently imported SQL backup verification. The historical >1 MiB prior-payload streaming case keeps its original reserved writer/export recovery seam via the shared historical fixture; its byte threshold and bounded-read assertions remain.

The publication-clock regression drives the actual native switch clock, bounds the stored timestamp by measured switch duration, proves two retained publication timestamps are reversed, and checks that the next game predecessor follows pinned ancestry. It waits for real backup verification before the next collection.

Exactly two new durable boundaries are added: Context rejection before commit and loss of a committed curated entity-write response. The former requires all four attempted effects to be absent and the cursor unchanged before exact typed output and replay. The latter compares actual retained content/SHA and checkpoint around all four response losses, then proves lagging progress, exact owner revision, one provenance entry, pause/resume, seal/replay, publication and refresh. No production code or test deadline changes are included.

## Runtime evidence

| Selection | Exact code / outcome |
| --- | --- |
| Stored publication clock before assertion correction | `d4138667` working correction: the initial exact timestamp assertion failed in 7.154s because the real switch consumed 7ms. The corrected assertion uses measured duration while still proving reversed retained timestamps. |
| Corrected clock | Working correction committed as `50414022`: 1/1 passed naturally in 8.858s. |
| Shared historical before-image fixture | Exact `50414022`: 1/1 passed naturally in 5.413s. |
| First two new boundaries | Exact `50414022`: Context passed; curated failed before its seam because an opaque fixture key contained spaces; natural 4.953s. |
| Corrected two boundaries | Working fixture correction committed as `45048ce2`: 2/2 passed naturally in 10.406s. |
| First full affected file | Exact clean `15bf19e3`: **49 passed, 12 failed**, 61 tests, natural 146.428s. Each retained-state outage reached the final Printing comparison; the native seed had private `locator_evidence` absent from the recovered record shape. |
| Corrected retained-state matrix | Exact clean `e87612aa`: **12/12 passed**, 49 filtered, natural 41.704s. |
| Final full affected file | Exact clean `e87612aa`: **61/61 passed**, natural 145.823s; Vitest 144.76s, test time 142.61s. |

The final comparison reuses the existing `consumerContent` projection for Printing facts and separately re-reads every original native seed record for exact before-image equality. Exact Card/Printing/Erratum identities, effective text and all injected-failure/cursor assertions remain.

All local selections use Node 22.23.2 and one runtime worker. Individual repository deadlines are unchanged; focused outer bounds are 180s (clock/two faults), 600s (12 retained-state cases), and the full file uses the repository's 2160s ingestion-shard outer bound. Every recorded run completed naturally; raw workerd cancellation, disposal and deliberately injected error diagnostics are preserved even on passing runs.

The final red, focused green and full green logs, exact commands/commit/status/timing metadata and SHA-256 checksums are committed under `docs/reviews/evidence/reconciliation-progress-20260909/`. Earlier selections remain at `/tmp/card-keepr-launch-20260909/issue-276-reconciliation-faults/`. Full repository typecheck and focused lint/format/diff checks pass.

## Integration status

Hosted run `34346618971` at `15bf19e3` completed with failures. Static/domain/API checks passed. Ingestion shard1 had 206 passed/56 failed; shards2/3 were incomplete at that branch's old 12-minute limits. Acceptance shard1 had 156 passed/1 failed/1 skipped, shard3 had 82 passed/3 failed; shard2 was incomplete at its old 20-minute limit. Retired caller failures and a P-001 adverse-refresh native failure remain coordinator integration work. No run was cancelled by the agent, and partial jobs are not green. Raw hosted logs are retained as `/tmp/card-keepr-launch-20260909/pr287-15bf-*`.

Whole integrated validation, remaining #274 caller migrations and the rest of #276 remain open. This PR closes no launch ticket.
