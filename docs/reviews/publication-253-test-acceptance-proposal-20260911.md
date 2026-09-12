# Proposed publication stress acceptance

11 September 2026. **Proposal only.** No production contract, existing timeout,
CI gate or GitHub issue acceptance has been changed. The 120-second failures
remain failures under their original conditions. This proposal follows the
[requirements review](publication-253-requirements-20260911.md), not a publication
completion SLA.

## Completion and correctness

Keep the original 1,001-Product source fixture, including its 1,001 Cards,
1,001 Releases, 1,001 Distribution Contexts, Supported Game and Game Profile.
Keep all of the original Product test's substantive assertions:

- Candidate partition pages terminate, contain at most 100 descriptors, and
  respect the existing 512 KiB / 500-record partition guards.
- Whole-candidate inspection and exact owner approval lead through the shipped
  private preparation, public preparation and guarded atomic publication paths.
- Publication reserves its actual backup. The real SQL export is uploaded,
  imported into a separate database, and independently verified. The checkpoint
  belongs to the exact acceptance/publication, including a no-change acceptance.
- All 1,001 Products, Releases and Distribution Contexts are present with correct
  references. Their uncompressed public data still exceeds 8 MiB. No large
  field is shortened to make a measurement easier.
- Follow every manifest page; verify its digest and cursor progress; fetch stored
  components; check compressed length/hash, decompressed length/hash, record
  schema, record counts and complete catalogue content. Verify every stored
  component against its retained digest.
- Under the **current** public contract, each component has exactly one record,
  each page has at most four components, and the original minimum stored-file
  assertion remains. A grouped experiment is a different format, not a pass of
  these assertions.

Propose changing **only the large Product journey's test-body hang cap from
120,000 to 300,000 ms**, after recording this acceptance decision in #253. The
known incomplete hosted samples reached roughly 122–175 seconds; five minutes
provides diagnostic headroom to complete the work without imposing that speed
on the application. This is an engineering choice, not a proven ideal cap or a
new SLA. Keep finite setup, teardown and the existing full-stress job cap. Do not
move substantive work outside the recorded journey or rely on test retries to
hide a failure. On timeout, retain the last durable phase/cursor, backup state,
resource counters and unfinished assertions.

The isolated comparison uses its own explicitly larger finite bounds for
**two-publication histories**, not the proposed five-minute single-journey gate.
It does not edit or retrospectively satisfy the original test deadline.

## Performance and total work

Keep the native candidate's **less-than-15,000 ms** callback-journey assertion,
its existing workload and its separate harness timeout unchanged. Report its
measured interval, environment and pass/fail independently. A new Product hang
budget, a fast full publication, or a routine CI pass cannot satisfy it.

For publication, emit measurements rather than an invented elapsed-time pass
threshold: collection, candidate work, private preparation, public preparation,
switch, SQL snapshot/artifact verification/export/import/restored verification,
and consumer verification. Publish inclusive and disjoint timing definitions;
never sum nested intervals. Count files created/reused, storage requests and
retained bytes by class, D1 statements and available row/index work, SQL bytes,
restore work and fault replay. Exclude observer-only census work from application
request totals and retain it separately. Label emulator metadata and host RSS;
missing isolate peak memory or production billing stays unavailable.

Use the same pinned toolchain and sequential heavy local runs. Preserve every
failed or incomplete sample. Repeated observations may describe variability;
choosing the fastest run does not establish a performance guarantee. Establish
publication frequency, consumer download behavior and a tolerable background
window before adding a publication performance gate.

## Histories, faults and a possible format decision

Exercise full→unchanged and full→one-fact-changed histories through real
production functions and D1/R2, with actual backup/restore and full consumer
verification after **each** acceptance. Normalize only independently generated
identifiers when comparing separate fixture databases; retain all facts,
lifecycle fields and relationships. Within each history require exact stable
identities and byte-identical public exports for no change.

The failed third export of the longer full→unchanged→changed history remains a
separate emulator/recovery-capacity gap. Fresh pairs permit a bounded layout
comparison; they do not prove longer histories recover, and do not justify
pruning history, fabricating a checkpoint or replacing SQL restore with a mock.
Retain that failure for #275's accounting/capacity work.

Keep small existing tests for atomic visibility, exact replay, partial staging,
corruption, stale/expired/abandoned writers, backup failure/resume and shared
object cleanup. Keep dedicated real Workflow binding tests: manually repeating
a production callback proves durable transitions, not platform scheduling or
instance termination. Measure one failed unit and its replay independently of
uninterrupted publication timing.

If grouping is chosen, record a deliberate public format decision first. Update
the manifest schema, producer, consumer validation, serialization/runbooks,
backup descriptor validation, deletion assumptions and format assertions
coherently. Before Go-Live, follow ADR 0008's in-place contract/regeneration
policy; do not invent a compatibility layer. Retain record-level correctness
oracles and explicitly replace only the superseded file-layout assertions.

A shipping grouped implementation must also prove byte/count boundaries,
large-record handling, deterministic membership, insertion/deletion effects,
changed-object downloads, exact replay after partial writes, corruption and
cleanup fences. The bounded experiment is evidence for that decision; it is
not a general capacity or production-readiness certificate.

## Issue acceptance

#253 should remain open until the agreed final code/runtime has a complete
intended full selection, every failure has a disposition, the separate native
performance requirement has its result, and final full manual plus bounded
scheduled/manual workflow evidence is recorded. If the Product hang cap is
revised, name that revision explicitly in the issue and new run's evidence.
Routine CI, an isolated comparison or a local pass is insufficient.

#275 still owns usable 5/50 GiB workloads, source completeness, retained-history
capacity and resource/accounting evidence. This 1,001-Product comparison neither
completes those tiers nor resolves the observed emulator SQL-export failure.
