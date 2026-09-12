# Independent review of the publication layout experiment

11 September 2026. Reviewed the retained
[single-component patch](evidence/publication-253-comparison-20260911/single-experiment.patch),
[grouped patch](evidence/publication-253-comparison-20260911/grouped-experiment.patch)
and the corresponding scratch worktree. No tests or implementation edits were
performed by this review. The grouped full measurements were running separately
at review time; this is chiefly a methodology and limitation assessment.

The comparison is useful for choosing the next architecture experiment. It uses
the same uncommitted production starting point, original 1,001-Product fixture,
native candidate preparation, private artifacts, owner approval, atomic switch,
R2 storage, real SQL export/import and restored verification. It retains the
original Product count/relationship/size/stored-hash checks, then adds complete
consumer decompression, record/schema/count and compressed/raw digest checks.
The grouped branch deliberately changes its experimental manifest assertions
and backup descriptor check. The separate 900-second experimental test envelope
does not make the original 120-second acceptance pass.

## What is actually compared

- Only **public export packaging** is grouped. Private projections, search,
  lifecycle and private export artifacts remain on their existing per-record
  pipeline. The experiment cannot estimate savings from grouping private files.
- The variant selects public sources by a `(kind, entity_id)` keyset, groups up
  to four records within a two-hex identity range and renders one group per
  callback. The baseline advances up to four single-record units per callback.
  This is a comparison of two complete packaging implementations, including
  query order, cursor and transaction frequency; it does not isolate compression
  or record count as the sole cause of a timing difference.
- The changed scenario modifies **one Card name** by appending `" changed"`.
  It does not change a Product field, insert a record or change a dependency
  fan-out. Exact within-mode unchanged equality and cross-mode normalized
  catalogue content are meaningful for these scenarios. Cross-mode normalization
  of generated Card/revision identities is not proof of identical raw IDs.
- A no-change publication explicitly keeps the same revision, but does **not**
  avoid backup work in the completed single-record pair. Its
  [results](evidence/publication-253-comparison-20260911/single-final.json.unchanged.gz)
  name distinct verified backup attempts and SQL-import phases. The
  [log](evidence/publication-253-comparison-20260911/single-final.log.gz) records SQL
  exports of 162,475,627 and 410,950,760 bytes and real imports with zero foreign
  key errors. Unchanged consumer files therefore do not imply unchanged private
  preparation, retained history or backup cost.

## Stable grouping is partial

The group identity includes kind/range and its first member; reuse input hashes
include the ordered member identities and input digests. A simple fact change
can retain unchanged group membership and reuse other content-addressed bodies.
An insertion changes chunks from its position to the end of its own identity
range. It does not shift grouping in later distinct ranges. That is a useful
improvement over globally taking every four records, but remains a property of
the code, not a measured insertion outcome in this experiment.

Global component ordinals and descriptor names still use `component_count`.
Adding a component can shift every later ordinal, descriptor and composition
ancestor even when those components' compressed bytes are reusable. Distinguish
**reusing body objects** from **reusing publication metadata**. Skewed ranges,
non-hash identity fallback and boundary splits still need a deliberately inserted
record case before promotion. Changes to per-record dependency/call estimates
can also change grouping within a range.

## Known prototype gaps

The 256 KiB check runs while rendering the already selected group. Exceeding it
throws instead of emitting a smaller group and retaining the remainder for the
next cursor. A single record larger than 256 KiB also fails, although the
baseline allows larger records. Thus this prototype is bounded for its accepted
fixture; it is **not yet a general byte-bounded grouping implementation**. A
production change needs deterministic byte splitting, the existing oversized
record policy and boundary/replay tests.

The grouped rendering branch omits the baseline's explicit translation of
invalid composed-record errors into `InvalidPublicExport`; unexpected bad
records may follow a different retry/failure classification. Prior grouped
descriptors also need full validation rather than only upper-bound checks. The
scratch schema broadens the existing `@5` name and the backup verifier accepts
1–4 records; that is an intentionally isolated contract experiment, not a safe
production rollout or an approved contract version.

The reported 64-Product interruption probes exercise loss of one successful
public PUT response, retry and exact committed-callback replay through real
storage. The grouped probe has groups of up to three records overall; the
interrupted first group may be a singleton. They do not prove interruption at
every cursor/phase, maximum-byte
groups, corrupted grouped bodies, concurrent publication/fencing, deletion,
skewed insertion or all late private 99/97-call branches. Keep the existing
hard callback guard; do not infer worst-path safety from an average count.

## Reading the counters correctly

The instrumentation records method entries and emulator metadata. D1 `first`
uses the same real SQL through `all` to retain metadata before returning its
first row. Both variants share this instrumentation, but neither represents
production wall time or billing. Deterministic test UUIDs and controlled
Workflow drivers are fixture controls; scheduler throughput is not measured.

Parent phase elapsed times include child phases; summing them double-counts
time. Use exclusive time (`ms - child_ms`) or report the nesting. Callback
`max_calls` counts the category's counters and omits nested `backup.*` counters,
so it is not a complete backup request count. Restore-provider SQL/query logs
are separate from the wrapped D1 counters.

`created_components` means a component digest is absent from the immediately
previous revision's component set. It is not proof of a new physical object:
an older retained object could be reused. Use PUT outcomes and inventory deltas
alongside it. `returned_object_bytes` includes HEAD-declared sizes; only the
separate GET/body and actual consumer byte measurements should describe fetched
bodies. Inventory runs after the measured interval, consistently in both modes;
its row/object totals describe retained state rather than all work performed.
The test additionally buffers whole consumer catalogues, so process RSS cannot
be attributed to production Worker memory.

This experiment can support a limited recommendation about public component
size, request/metadata amplification and full versus incremental download tradeoffs.
It cannot close #253, certify #275, establish production costs, authorize a public
format change or justify another infrastructure platform.
