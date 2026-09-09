# Capacity fixture and retained source census — #273

This is the fixture/accounting prerequisite for #268 and #275, under private
launch tracker #216. It does not establish usable capacity, a memory limit,
throughput, billing or restore success. The fixed implementation base is reviewed
cleanup `a14a803434dcc7bb150802dad3476989d0f61355` (PR #277). The immutable
September 6/8 source packs remain unchanged; #267 owns active-source recapture.

## Reproducible synthetic workloads

The fake publisher now serves the full tiers as bounded JSON record pages with
image URLs and separate streamed image responses. Both Workers-pool and native
acceptance transports use the same generator. Start the test-only adapter
`fixture-one-piece-capacity@1` at the first page below through the existing
fixture Evidence Plan seam. Its registered record extraction discovers the next
page and every image request from retained page content; it rejects missing or
changed image declarations. One page produces at most 16 observations, 32 image
requests and one next-page request for the full tiers.

| Workload ID | Printings | Images | Exact image bytes | Exact structured bytes | Pages | Total source requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `128-images` | 128 | 128 | 13,107,200 | 1,048,576 | 8 | 136 |
| `tier-1` | 10,000 | 20,000 | 5,368,709,120 | 104,857,600 | 625 | 20,625 |
| `tier-2` | 100,000 | 200,000 | 53,687,091,200 | 1,073,741,824 | 6,250 | 206,250 |

The first page is
`https://official-source.invalid/reconciliation/capacity-<ID>-page-0`.
Images are `https://official-source.invalid/images/capacity-<ID>-<index>.png`.
Byte shares use an integer quotient plus one byte for the first remainder
partitions, preserving exact totals without unsafe large intermediate products.
Structured bytes include the entire JSON envelope and URL metadata, with
synthetic rules text spread across records. The 1 MiB structured budget for the
128-image workload is an explicit fixture choice, not a historical measurement.

Each response is a valid 1×1 PNG containing deterministic ancillary payload
bytes before IEND. PNG chunk CRCs and decompressed pixel bytes are tested. No
response is materialized as an entire image inside the producer; a pull generates
at most 65,536 payload bytes, and cancellation stops production. There is no
whole-tier list, image buffer, digest cache or output directory. This measures
transfer/storage input shape, not realistic artwork dimensions, image-decoder CPU
or compression characteristics of real card art.

`capacityPageDocument(workload, page, printingsPerPage)` and
`capacityImageResponse(workload, index)` accept small parameterized workloads for
contract checks. A page has 1–128 Printings, at most 2 MiB of serialized structured
input, and 1–3 distinct image roles per Printing; partial final pages are supported.
The canonical routes and adapter use 16 Printings per page. The adapter may hold
one bounded page text/object and its bounded request list; the source generator
may hold one page object and serialization plus one image stream chunk per active
response. These are construction bounds, **not measured Node RSS or Worker
isolate peaks**. Keep page size, collection batches and concurrency fixed during
increasing-page measurements.

The fixture adapter keeps the existing 5,000-request policy. Full image graphs
exceed that policy; tier 2 also exceeds the global 25,000-request emergency ceiling
for one run. A capacity pause/rejection is an outcome to record, not usable
capacity. #275 must resolve a supported workload/run arrangement and exercise the
actual pipeline without weakening guards to claim success. The old
`capacity-tier-admission.stress.spec.ts` intentionally remains a zero-capture,
page-admission-only probe. Its 625/6,250-page outcomes are not these complete
image-graph outcomes. Historical `scale-128-images-*` scenarios remain explicit
inline regression reproductions for the publication/stress lanes; the separate
`128-images` fixture is the new transport/capacity input.

## Retained real-source census

Run this offline; it checks every body/header SHA-256 against the immutable
manifest, reads one response at a time, counts actual source records/image URLs,
and verifies every linked mapper page is retained:

```sh
node scripts/source-evidence/capacity-census.mjs > /tmp/issue-273-source-census.json
```

The committed [machine-readable census](issue-273-source-census.json) retains
manifest hashes, each capture's source URL, file, timestamps, body/header byte
counts and digests. It describes **43 retained responses**, comprising
7,471,079 document bytes, 9,104,686 image bytes and 29,036 serialized header bytes.
It includes corroboration and the older embedded Riftbound gallery separately,
so these must not be silently added to every runtime workload.

| Declared retained scope | Source records | Image URLs / retained images | Document bytes | Image bytes | Header bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bandai English P-001 search | 7 | 7 / 7 | 69,805 | 1,403,621 | 2,777 |
| Limitless English P-001, base plus seven variants | 8 | 8 / 8 | 189,626 | 885,446 | 9,778 |
| Separate Bandai trophy corroboration | event page | 1 / 1 | 50,882 | 1,090,732 | 630 |
| Riftbound six mapper card pages plus five-set inventory | 1,189 | 1,189 / 0 in this pack | 3,249,095 | 0 | 5,973 |
| Six representative Riftbound images from September 6 | 6 sampled records | 6 / 6 | 0 | 5,724,887 | 6,280 |

The two One Piece scopes describe overlapping P-001 appearances, not 15 distinct
Printings or the complete One Piece game. The event image is corroboration outside
the seven-entry official search scope. For Riftbound, linked pages return
200/198/200/198/198/195 records while publisher metadata says 1,197; the difference
of eight remains unexplained. All 1,189 returned IDs and image URLs are unique.
There are **1,183 unretained image URLs with unknown byte counts**. The six images
cannot establish a full-image budget. Neither source census is a configured
request capacity or a canonical Card/Printing census.

## Storage planning and machine prerequisites

Use `capacityStorageBudget(workload, measurements)` to add **disjoint, coexisting**
logical byte components. A missing component remains `null`; the function reports
only the known lower bound until all components are supplied. It deliberately
rejects negative, unsafe or unknown component values. No base64 multiplier is
applied to the new source topology.

| Component | Required accounting boundary |
| --- | --- |
| `raw_source_bodies` | Exact structured plus image source bodies, counted once. Headers and transport framing are separate from these synthetic body budgets. |
| `sealed_records` | Retained record payload objects, excluding raw bodies and indexes. Measure post-intake serialization expansion. |
| `records_indexes_d1` | D1 tables plus named **and automatic** indexes, and sealed-record index objects. Include page allocation/WAL in this category or overhead once. |
| `published_image_copies` | Extra materialized/serving image copies, only where distinct from raw evidence. Recompute after #274 storage changes. |
| `history_exports` | Current plus two predecessors' retained exports, backups and historical objects that are additional to the categories above. Shared image references do not imply duplicate image bytes. |
| `concurrent_work` | Additional active collection/preparation/backup objects at the measured concurrent checkpoint. Do not repeat current objects here. |
| `restore_staging` | Actual coexisting SQL export/download/import files, restored database/indexes and any separately copied restore image/evidence objects. Use actual isolated restore, not the backup object's size. |
| `filesystem_overhead` | Additional allocation, logs and profiler artifacts not already counted. Logical versus allocated bytes remain separate measurements. |

The known raw-body lower bounds are **14,155,776 bytes** (128 images),
**5,473,566,720 bytes / 5.09765625 GiB** (tier 1), and
**54,760,833,024 bytes / 51 GiB** (tier 2). These are not total free-disk
requirements. The other components remain explicitly unmeasured for the new
publication topology; #275 must fill them from a small end-to-end run and actual
restore checkpoints before reserving storage for full execution. The historical
18.33/183.33 GiB inline-base64 estimates are neither current fixture budgets nor
real-source hardware requirements.

Historical measured P-001 and Riftbound journeys in
[the #233 ledger](issue-233-capacity.md) reached sampled local logical occupancies
of 399,214,906 bytes (`2bfc81b`, six-publication P-001 journey) and 3,941,169,124 bytes
(`2cdb459`, Riftbound with injected missing-image responses), including restore
copies. Those old implementations and repeated publication journeys are not
linear full-tier expansion factors. P-001's old index census omitted automatic
indexes. Reuse the accounting helpers, not these figures as new measurements.

The contract/census checks need the repository's supported Node version and
installed baseline dependencies, no Worker boot and no generated GiB files.
On 9 September 2026 this lane used Node 26.3.0 on macOS arm64, 16 GiB RAM and
10 logical CPUs; a point-in-time filesystem sample showed 15,421,255,680 available
bytes. Free space is volatile. It cannot retain tier 2's raw lower bound, and does
not prove sufficient storage for tier 1 plus unresolved components. Fixture
producer memory and the separate ingestion Worker isolate must be measured
independently. Do not infer a 16 GiB hardware requirement from this host.

For #275 reserve one exclusive heavy-test lease for the host, stop competing
Workers/test/profiler processes, choose a volume with space for **all** measured
components plus declared headroom, and record free/allocated bytes before and
after each checkpoint. Do not run both tiers concurrently. No provisioning,
billing, deployment, live cleanup, or Go-Live is authorized by this work.

## Validation handoff

Focused checks:

```sh
npx vitest run --config test/domain/vitest.config.ts test/domain/capacity-workloads.spec.ts
node --test acceptance/capacity-fixture-accounting.test.mjs
npm run typecheck
```

The TDD sequence observed failing missing-generator and missing-extractor tests
before implementation. PNG validation also caught an invalid initial IDAT/CRC
fixture and passed after replacing it with a complete valid image. These were
implementation-stage failures, not production regressions. Small contract tests
cover exact census partitions, first/last and partial pages, independent PNG
CRC/decompression, bounded image chunks, image discovery and missing-image
rejection, and additive storage accounting with explicit unknowns.

#275 owns the actual 128-image pipeline, both full tiers, increasing-page samples,
isolate/CPU/service-call/storage/cost measurements and resource reservation. #276
owns final durable faults and actual composed restore. #271/#253 own final suite
reliability/stress verification. This fixture ticket cannot certify those gates.

Final local outcome before independent review: focused generator/extraction
contracts **7/7**, accounting/retained census **2/2**, full domain **251/251 across
44 files**, and repository typecheck passed. An earlier full domain run failed
3/251 because adding the adapter first changed the positional fixture selected by
`bounded-page-extraction.spec.ts`; appending the new registration preserves the
established order, after which the affected 13 tests and complete suite passed.
Targeted lint has no errors and retains the pre-existing unused `surface`
parameter warning in `reconciliation-documents.ts`. No check was interrupted.
No heavy Worker/Miniflare test, full runtime suite, capacity measurement or live
operation ran in this lane; final integrated runtime validation remains with the
coordinator under the exclusive host lease.

Independent fixed-base reviews are complete for implementation
`4348f18d0b0d23fdb08ed41a8ab04909de35786e` against
`a14a803434dcc7bb150802dad3476989d0f61355`: Standards reported zero documented
violations and zero smell findings; Spec reported zero findings. The coordinator
retains integration and issue completion authority. These reviews do not supply
new runtime or capacity evidence.
