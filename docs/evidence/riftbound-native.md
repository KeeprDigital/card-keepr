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
checkpoint amplification should inform the separate #233 performance work. A
longer local probe reached its deliberate 2,000-callback cap at input-preparation
ordinal 1,199 without completing that stage; total preparation work exceeds that
partial count and remains unresolved capacity evidence. No Workflow shard limit
was raised.
This local reproduction used SQLite and a
small R2 interface over copied retained bytes, including multipart images; it is
not a native Workflow or publication/recovery pass. Focused regressions cover
long gaps, terminal cursors, a partial gap before a document, and graph-stage
progress. Another native run remains required.

## Candidate-list CLI cursor failure

Frozen commit `412c518` completed the same real-source collection and advanced
past the repaired document, graph and normalization stages. In 348.24 seconds it
reached the assertions for 14 retained snapshots with matching body digests,
1,229 observations and 1,189 unique paginated Printing proposals. The initial
candidate had reached a terminal sealed/failed state.

The next shipped CLI call, `game-candidate list --run-id <run>`, failed with
`invalid_cursor: Use the returned candidate cursor.` The CLI serialized an absent
optional cursor as `?after=`; the server correctly distinguishes that invalid
empty cursor from an omitted cursor. A runtime-free CLI transport regression
reproduced the exact outgoing path. The route builder now omits absent optional
query parameters and preserves supplied opaque cursors. All three transport
tests pass.

This run did not reach owner admissions, publication, API/export assertions or
restoration. Its normal teardown removed the disposable state. Subsequent failed
Riftbound replays preserve their local state for diagnosis after all runtimes
stop; successful runs still remove it. The CLI fix was verified without another
collection.

## First public export failure and contract repair

Frozen commit `efd9000` ran for 643.83 seconds. It verified 14 retained
snapshots, 1,229 observations and 1,189 unique source Printing proposals,
completed six explicit owner Printing admissions and 30 Card-only admissions,
and sealed the reviewed candidate. The first publication then failed with
`public_export_record_invalid`. No resulting revision, API/export consumer
assertion, Curated Revision, fresh collection or restoration succeeded in that
run. Its stopped SQLite/R2 state was retained for diagnosis.

The shipped serializer's first record was a `supported_game` with key
`riftbound` and profile `riftbound@1`. The active public v5 schema still listed
four games. The active public record/manifest, API and administration contracts
now include the accepted Riftbound game/profile/component and nonempty
`publisher_name` identity variants. Historical export schemas are unchanged;
public manifest pages still allow at most four components.

Read-only reconstruction against the failed run validates all 130 actual
prepared records: one supported game, one profile, 36 Cards, six Printings,
six images, nine Products, nine Releases, 31 Errata and 31 relationships.
Invoking the shipped record preparation function with an in-memory R2 interface
also produces 130 compressed components whose advertised record schemas
validate. Their descriptors validate in 33 derived manifest pages. Those
manifest pages use diagnostic revision metadata; this is contract validation,
not a published manifest or native publication/recovery pass.

After integrating actual main `3b756156`, review caught a separate inherited
serialization defect: resolved evidence metadata included `cardIdentities:
undefined` for default complete scopes. The actual canonical serializer rejected
that property for both Bandai and Riftbound. Conditional omission preserves the
absence of an identity restriction; the named P-001 scope retains its exact
identity array. Three regressions cover both defaults and the named scope.

The native fixture supports an explicitly labelled retained-run resume using
`KEEPR_RIFTBOUND_RESUME_DIRECTORY` and `KEEPR_RIFTBOUND_RESUME_RUN_ID` together.
It rechecks retained evidence, replays owner decisions with their original
idempotency keys, and prepares/publishes under new keys through shipped owner
operations. It skips the original collection and migrations; all subsequent
consumer, Curated Revision, fresh Origins collection and recovery assertions
remain required. A resumed result must not be reported as a fresh full journey.

## Published revision and failed backup continuation

Frozen commit `85b00f2` resumed the retained pre-publication run and stopped after
323.07 seconds. The supported owner flow published
`catrev_aac461c4-afba-4fc1-ab96-3eb6c335a8f5`. Its automatic backup attempt failed
with `backup_failed`, detail `Network connection lost.` The helper waits for
verified backup before returning, so no consumer, Curated Revision, fresh
collection or restore assertions ran. All runtimes stopped and state remains
retained. This was a resumed publication, not another collection.

Two fixture defects were independently reproduced after that failure. The
Riftbound outbound router recognized Cloudflare management but omitted the
checkpoint transport's signed SQL download/upload hosts. The focused regression
fails at `native-export.invalid` with the old routing, then passes forwarding
all three original requests and rejecting an undeclared host. The retained
published database's raw SQLite dump also measures 162,431,985 bytes (longest
line 524,478 characters), above the helper's 64 MiB subprocess stdout buffer.
That raw diagnostic dump includes derived FTS rebuilt after the failed attempt;
it is not a backup artifact. A separate actual SQLite roundtrip exceeding
64 MiB fails with `ENOBUFS` under the old helper and passes with SQL streamed to
a file. Existing export filtering, virtual-table rejection and full SQL import
verification remain intact. Neither isolated reproduction establishes which
fixture defect produced the earlier generic network failure.

The shared linear virtual-table scan from #239 (`b5208cc`, consumed as
`564f7f4c`) is also retained. Its scan of the raw Riftbound dump took 110.9 ms;
this measurement is distinct from native recovery and production capacity.

For the published failure checkpoint,
`KEEPR_RIFTBOUND_RESUME_PUBLICATION_ID` additionally selects the existing
publication. The fixture rechecks retained evidence and admitted identities,
retries its failed backup through the owner CLI using the exact failed-attempt
digest and resolved target, and requires verified backup before continuing.
All consumer, Curated Revision, fresh-collection and restoration assertions
remain required and pending. No publication ledger or backup receipt is edited.

Frozen commit `de9cb68` then stopped after 115.61 seconds on a fixture assertion:
the owner CLI accepted `riftbound-signed-transport-backup-retry` and returned the
running backup Workflow contract with exit code 10, while the fixture expected
zero. The retained retry state is `exporting`, with no failure code. This is not
a backend backup failure or a verified backup result. The original publication
and failed attempt remain unchanged.

The fixture now accepts exit 10 only for the exact running backup Workflow
contract, matching retry key and nonempty Workflow ID; unrelated contracts,
failed status, another retry key and other nonzero codes are rejected by a
focused regression. On continuation it inspects the existing retry, validates and invokes its
advertised resume body with the same identity if active, then polls it without
allocating another retry. Consumer and restoration proof remain pending.

Frozen commit `725b073` reached the bounded 120-second backup poll deadline
(238.37 seconds total including evidence/admission reinspection). The existing
attempt still reported `exporting`, no failure, no exported byte count. The
revised SQLite export helper was never invoked. All runtimes stopped.

Offline inspection of the local Workflow SQLite decodes `ENGINE_STATUS` as
Running (1). Its entire history still contains only four events ending at the
first step attempt start, `2026-09-07 21:08:44.808`, from the preceding run. No
events were added during the exact-identity resume. The installed Miniflare
status method reads that persisted state. The shipped Workflow driver correctly
observes an existing Running instance and invokes resume only for Paused state;
a runtime-free invocation confirms neither create nor resume is called for
Running. This local interrupted-Workflow limitation prevents this retained
attempt from supplying completion evidence through the available owner path.
There is no claim that a production Workflow has this limitation. No ledger or
Workflow metadata was altered. A fresh corrected native journey is required;
continued polling or another retry identity is not a substitute.
