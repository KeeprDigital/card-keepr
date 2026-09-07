# Riftbound native acceptance evidence

## Failed collection-to-preparation replay

Frozen commit `a94d46a`, 8 September 2026 Melbourne time:
`node --test --test-concurrency=1 acceptance/riftbound-catalogue.test.mjs`.

The shipped owner collection flow reached `parsing` after approximately 303 seconds.
Persisted Source Requests totalled 1,195: one root JSON surface, five JSON listing
pages and six retained images observed; 1,183 image requests recorded the explicitly
injected `source_image_not_found` outcome. There were no pending requests. Twelve
Source Observation Sets were retained. This does not establish complete image
coverage or a production throughput/capacity guarantee.

The parent Workflow failed immediately after that transition. Its persisted state
at `2026-09-07 17:51:55.577` recorded event 3 with error
`Invalid Workflow step parameters.` No game preparation, candidate or Entity
Proposal was created. The test was stopped after this terminal Workflow failure
was confirmed; the empty-candidate polling deadline was not extended again.

A direct call to the shipped `workflowStepName` with `parent.prepareGame` and
`{ game: "riftbound" }` reproduced the exact error. The closed game pattern still
listed four games. The regression in `test/domain/riftbound-workflow.spec.ts`
failed before adding Riftbound and passed afterwards, including progress and
restart classification and rejection of an unregistered game. A full native rerun
is still required; this failed run is not a publication or recovery pass.

## Explicit authority regression

The source-authority Worker test reproduced a successful Riftbound designation
that disappeared from authority inspection. The read path only enumerated the
initial Bandai scopes. Including explicit decisions for new scopes, while keeping
their initial authority empty, made all four tests in that file pass. Replay,
stale-write rejection, the original defaults and idle-operation guards remain
covered. No implicit Riot authority was added.

## Prepared validation scope (not yet executed)

The full native journey now collects the six retained gallery pages and the
Origins Errata and 2027 Product articles in one declared complete scope. It
expects 1,189 gallery records, 31 Errata and nine Product observations. Its
1,197 planned requests comprise 1,189 image requests, six gallery pages and two
articles; this request count is unrelated to the gallery's disputed 1,197-record
metadata total. Fourteen retained bodies are served; the 1,183 other image
failures are injected by the replay.

The authored journey admits six visually reviewed Printings and 30 additional
Card-only Erratum targets, including the narrowly evidenced Dark Child alias.
It publishes all 31 corrections and nine announced Products, adds independent
image-backed Curated Revisions for Kinkou Monk's Printed Rules Text and Ahri,
Inquisitive's Ionia tag, and performs a fresh Origins-only collection. A new API
and administration boot from the actual verification import must preserve Card
and Printing IDs, image bytes, and both runs' Snapshot and Observation Set IDs.
These are assertions awaiting execution, not demonstrated outcomes.

`acceptance/five-game-recovery.test.mjs` separately uses small synthetic source
documents, eight native publications and real SQL verification imports to check
five-game sibling components and the current-plus-two query window. It makes no
real publisher coverage or production throughput claim and is also unexecuted.

The branch includes the Limitless registration migration 0025 from `38fa7a82`
because the shared adapter code is installed. After integrating main
`ea51172a` and its cleanup migration 0024, migration 0025 strictly requires
schema 24 and migration 0026 strictly requires schema 25. The populated rehearsal
passes the actual `23 → 24 → 25 → 26` chain, preserving ancestor data and inbound
foreign keys.

## Paused document preparation and bounded gap regression

Frozen commit `c432427`, 8 September 2026 Melbourne time, completed collection
with exactly 1,197 requests: 14 observed retained bodies and 1,183 injected image
404s. No requests remained pending. Initial candidate preparation then paused
with `ReconciliationDocumentStorageError`; the run was stopped at that first
confirmed defect and its SQLite/R2 state preserved. It did not reach owner
admissions, publication, API/export assertions or restoration.

A runtime-free reproduction invoked the shipped retained-evidence preparer and
its actual 100-call resource wrapper against copies of that state. The underlying
cause was `Reconciliation callback exceeds 100 calls.` After retained request
sequence 13, the next retained document was at sequence 106. Reading each
unavailable image selection consumed the callback budget before document
preparation could checkpoint. Retried callbacks repeated the same traversal.

Document preparation now checkpoints unavailable selections in bounded groups
and saves a partial gap before processing the next document. Graph verification
and normalization likewise retain progress through these gaps. Selection order,
selection integrity verification and the 100-call ceiling remain intact. The
original failing callback now yields after 23 SQLite calls; the saved-state
reproduction continued through document preparation, graph verification and
normalization to input preparation in 801 continuation callbacks from the saved
checkpoint. That callback count includes document and observation work as well as
repeated gap traversal; it is a functional result, not a capacity success. The
checkpoint amplification should inform the separate #233 performance work.
This local reproduction used SQLite and a
small R2 interface over copied retained bytes, including multipart images; it is
not a native Workflow or publication/recovery pass. Focused regressions cover
long gaps, terminal cursors, a partial gap before a document, and graph-stage
progress. Another native run remains required.
