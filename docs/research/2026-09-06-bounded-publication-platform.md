# Bounded publication on Cloudflare

Research date: 6 September 2026. Planning evidence for [Decide bounded durable reconciliation and publication](https://github.com/KeeprDigital/card-keepr/issues/214#issuecomment-5558801899). Platform facts were checked against current primary documentation. The owner accepted the budgets below as adjustable initial engineering targets, not measured application capacity, permanent limits or an implementation specification; the linked resolution holds the final policy.

## Owner decisions and architectural implications

Collection may run concurrently across sources/games. Reconciliation, review and publication serialize **per Supported Game**: each game has its own independently approved immutable candidate; multi-game atomic publication is not required. The original seven-day candidate deadline continues through approval and retries. There is no clock-triggered applicability invalidation: publish retained collected/reviewed facts, not scheduled correction activation. Future effective dates are informational and trigger no scheduled updates. Printed text and publisher-corrected text remain; tournament legality is excluded.

A suitable proposed topology stages immutable game-revision projections and objects independently, then publishes by changing a small global composition pointer. Approval binds the candidate and that game's expected prior revision; an unrelated game's publication must not invalidate it. A CAS conflict may recompose the latest unrelated game references and retry, but must never change the approved game's facts, digest, expected predecessor or deadline. Conflicting changes to that same game require fresh reconciliation/review.

The composition must reference immutable per-game export manifests and their existing components. Updating one game must not copy or rebuild all other games' exports. Keep the pointer constant-size by referencing an immutable composition object; if the game-reference index itself grows beyond its budget, partition it rather than inserting an unbounded map into the final transaction. Consumer reads must pin a composition and resolve its game references consistently; API and export views must identify the same composition. A compatibility format that mandates one fully flattened global file would reintroduce whole-catalogue work and needs explicit replacement in the later spec.

Final publication uses a database-enforced compare-and-set and readiness guard **inside the committing transaction**. A preliminary `SELECT` followed by an unchecked batch is racy. Conditional writes must not allow a zero-row failed CAS to leave sibling mutations committed: guard the entire batch through a transaction-failing assertion or equivalently make every mutation conditional and prove the outcome. The transaction checks current composition, the expected game revision, immutable staged readiness, writer ownership, original deadline and recovery fence, then records the new composition and operation outcome. Verification and cleanup must be bounded and completed outside this small switch; immutable readiness records prevent changing verified inputs afterward.

Per-game publication does not imply independent database recovery. The owner selected concurrent collection, preparation, review and durable approval while backup verification runs, with a global checkpoint only at final publication: verify the current composition's backup before publishing another. Actual shared-database recovery remains a global mutation fence. Backup provenance must identify the exact composition/database state protected, and recovery must classify unpublished staging and pending operations without exposing them or promising to recover work newer than its snapshot.

## Verified platform facts

- **Workflows:** paid plans provide a default 30-second CPU allowance configurable to five minutes; platform step wall time is unlimited, subject to configured step timeouts. Non-stream results are limited to 1 MiB, persisted instance state to 1 GB, and steps to 10,000 by default (25,000 configurable). Completed state is retained for 30 days. Keep durable catalogue/audit history in D1/R2, returning references from steps. The limits page has inconsistent concurrency numbers (50,000 in its table, 10,000 in nearby prose); this design does not depend on either ceiling. [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
- **Memory:** Workers have 128 MB per isolate, shared by concurrent invocations, and six simultaneous outgoing connections. Streaming helps with bytes but not parsed-object/serialization overhead. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- **D1:** paid databases have an unexpandable 10 GB limit and execute queries serially. Individual rows/strings/BLOBs are capped at 2,000,000 bytes, SQL at 100 KB, bound parameters at 100, and query/batch duration at 30 seconds. Large mutations require bounded batches. Staging plus retained revisions/indexes can become the capacity ceiling before image storage does. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- **Transactions:** `batch()` executes a transactional sequence and rolls it back when a statement fails. This supports the small guarded publication switch, not a cross-service transaction. [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- **Read consistency:** replicas may lag. Sessions provide sequential consistency; `first-primary` starts from current primary data, and bookmarks carry minimum freshness between sessions. Read the composition and its revision-addressed projections within a consistent session; preserve required freshness across paginated requests. [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- **Objects:** R2 supports conditional writes and supplied SHA-256 integrity checks. Immutability still requires application key/ownership rules. [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) Direct object writes are strongly consistent; completed objects can be verified before the D1 reference is made visible. There is no implied R2+D1 transaction. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- **Multipart:** non-final parts must be equal-sized and at least 5 MiB; limits are 10,000 parts and 5 TiB per object. Incomplete uploads expire after seven days by default. Persist upload/part identities and handle expiry rather than relying on Workflow memory. [R2 uploads](https://developers.cloudflare.com/r2/objects/upload-objects/)

## Queues and Durable Objects alternatives

Queues can distribute independent image or partition jobs, buffer bursts, and cap consumer concurrency to protect downstream systems ([consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)). They deliver at least once, so duplicate-safe job identity and durable completion accounting remain necessary ([delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)). A Workflow can orchestrate those jobs, but adding Queues also requires dispatch recovery and a reliable completion join; queue delivery alone is not proof that a candidate is ready. Queues are an optional later execution mechanism if bounded Workflow fan-out proves inadequate, not necessary merely to support multiple runs.

Durable Objects provide a named coordination point with private transactional storage ([concepts](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)). A per-hostname object could coordinate pacing across concurrent collectors; a per-game object could coordinate admission to reconciliation/review/publication. Neither replaces bounded processing or the final D1 publication transaction, and keeping authoritative ownership in both D1 and a Durable Object would add consistency/recovery work. These are alternatives under discussion, not owner-approved additions to the topology. Workflows already provide persisted step execution and retries ([rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)); do not rebuild their orchestration solely to adopt Durable Objects.

## Cost dimensions

Workflows step/storage billing started 10 August 2026. Paid allowance includes 500,000 steps/month, then $0.80 per 100,000, and 1 GB-month state, then $0.20/GB-month. CPU and requests share Workers allowances. Waiting does not consume CPU. [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

D1 paid includes 25 billion read rows, 50 million written rows and 5 GB storage monthly; excess is $0.001/million reads, $1/million writes and $0.75/GB-month. Projection/index amplification and repeated staging matter. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

R2 Standard costs $0.015/GB-month, $4.50/million Class A operations and $0.36/million Class B operations, with included allowances and free Internet egress. Retained evidence, duplicates and backups must be included in storage estimates. These are unit prices, not a forecast or spend approval. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## Adjustable initial budgets

Tune these through representative measurement. They are smaller operational targets within platform ceilings, not asserted optimal values.

| Unit | Proposed budget |
| --- | --- |
| Metadata partition | At most 1 MiB serialized data and 500 records, whichever binds first; subdivide large records/relationships |
| Worker working set | At most 64 MiB peak isolate memory under representative concurrent work |
| Durable step | Target at most 10 seconds CPU, 100 service calls and four concurrent object streams; explicit wall-time timeout |
| D1 staging batch | At most 100 mutations and 1 MiB bound payload, also respecting per-statement parameter/row limits; target under one second p95 and five-second operational ceiling |
| Final publication transaction | At most 20 statements and 64 KiB request payload; no catalogue-sized scans, projections or cleanup; same latency target |
| Workflow shard | At most 1,000 planned steps and 5,000 planned service subrequests, with retry allowance and durable continuation |
| Export component | Independently addressable 8 MiB target; streamed multipart only when a large single artifact is necessary |
| D1 storage guard | Projected total at most 5 GB including retained revisions, indexes, evidence metadata and the maximum permitted concurrent game staging footprint |
| Administration requests | Bounded metadata pages within the partition byte/record ceiling; operation start/status target under two seconds p95 within the existing ten-second CLI deadline, excluding streamed artifact downloads |

Do not make one unbounded Workflow or one per-image step sequence for the whole catalogue. No image/export bytes belong in candidate metadata or Workflow result state. Oversized work must split or stop with an explicit capacity outcome, not silently truncate. Numerical targets need remote timing/CPU measurements and local memory profiling before becoming acceptance thresholds.

## Validation ladder and evidence limits

| Workload | Purpose |
| --- | --- |
| 128 images × 100 KiB | Reproduce the former deterministic failure and prove publication no longer depends on embedding the bytes |
| 10,000 Printings, 20,000 images, 5 GiB image bytes, 100 MiB structured data | Proposed intermediate synthetic scale test |
| 100,000 Printings, 200,000 images, 50 GiB image bytes, 1 GiB structured data | Proposed larger synthetic scale test, subject to staging/retention fitting the D1 guard |

Run repeated refresh, no-change and one-image changes; concurrent different-game staging/publication; same-game conflict; CAS contention; original-deadline expiry during approved retry; checkpoint interruption; object corruption; lost completion response; and backup/recovery. Prove unrelated-game CAS retries preserve the approved candidate, readers never see partial composition, and cleanup cannot delete objects referenced by another game/revision. Record bytes, rows, amplification, CPU/wall time, memory, calls, cost dimensions and operator actions. Use at least two sources for one game and actual representative second-publisher data alongside synthetic scale tests.

The [application review](../reviews/application-review-2026-09-05.md) measured a 17,526,322-byte image-bearing candidate rejected by the real 16 MiB guard from 128 images of 100 KiB. It did not measure a full-game run, peak memory or live timeout. The retained source dossier, `docs/research/2026-09-05-multi-source-catalogue.md` on local branch `research/multi-source-evidence` at `5128ec7`, records seven official P-001 observations, eight Limitless entries and roughly 3.38 MB of Riot gallery HTML/JSON, but no full-game census or throughput benchmark. Its pointer is in [Research real Bandai, supplemental, and Riftbound source evidence](https://github.com/KeeprDigital/card-keepr/issues/208#issuecomment-5550165033). Configured adapter request capacities are not observed entity counts. The synthetic ladder is neither a game inventory nor a launch-capacity claim.
