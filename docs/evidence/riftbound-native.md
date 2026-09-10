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

`acceptance/mixed-game-recovery.test.mjs` now uses two games with small synthetic source
documents, five native publications and real SQL verification imports to check
sibling components and the current-plus-two query window. The smaller replacement
passed locally on 10 September 2026 in 34 seconds. It makes no real publisher
coverage or production throughput claim.

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

## Fresh publication and verified backup; consumer rate-limit failure

Frozen commit `b8e863e` ran a fresh journey with all resume settings absent. In
707.34 seconds it collected all 1,197 requests, verified 14 retained bodies and
1,229 observations, admitted the 36 reviewed entities, and published
`catrev_1b329ff9-7bee-4814-af43-7f1f57d07776`. Its actual 105,526,484-byte SQL
backup completed import verification, with manifest SHA-256
`b683474520db80db10bb4b95e6dc42196d11235d63dcb17a3a354aac52c1f9c9`.

The first authenticated public export download completed its page/component,
byte-count and digest checks, and its six Printing IDs and explicit unknown
finish/reverse-face assertions passed. The next call redundantly downloaded the
same complete package to select Errata and received HTTP 429 on a component.
The shipped API allows 300 catalogue requests per 60 seconds and reports
`retry-after: 60` on rate-limit rejection. With 130 components and 33 pages, two
back-to-back package downloads exceed that limit. No Curated Revision, fresh
Origins collection or restore consumer assertions had run. All runtimes stopped;
this fresh state's terminal verified backup remains usable for continuation.

The fixture now caches a fully byte-verified immutable package by API address,
credential and revision for the current journey, selecting each record kind
from that package. It clears the cache before the restored API boot so those
bytes must be downloaded and verified again. Necessary export requests are
paced 250 ms apart; production limits are unchanged. A local HTTP regression
covers pacing, package reuse, explicit cache clearing, and rejection of HTTP429;
a failed download is not cached as success. The retained-published path also
recognizes a verified backup and proceeds without allocating or resuming a
backup attempt. The remaining consumer and restore assertions still await proof.

A further offline continuation check found that the local checkpoint provider's
in-memory import generation restarted at zero, which would reopen an existing
`restore-1.sqlite` on the next publication. It now selects a generation above
retained import files and reserves the new file exclusively, advancing past
allocation collisions. The actual SQLite regression reproduces the old identity
reuse and verifies restart, a retained generation gap, concurrent allocation of
distinct files, and preservation of earlier imported contents. This preserves
the terminal verified import while later publications obtain fresh independent
verification databases; it is a fixture correction, not a production migration.

## Native consumer checks and Curated target lookup

The frozen `c717988` verified-publication continuation stopped after 152.32
seconds. It reverified the complete export, 31 Errata and their targets, nine
Products and Releases, unknown regions and quarter precision, and the scoped
Dark Child wording. All six authenticated Printing reads and retained image
SHA-256 comparisons passed. The first Curated Revision validation then returned
`curated_revision_target_not_found`; no Curated Revision was created. All
runtimes stopped and the verified publication/backup state was preserved.

A read-only invocation of the shipped validator reproduced the same failure in
104 ms against the retained database. Curated Card/Printing targeting still
queried legacy revision tables; native publication stores its membership in the
composed publication projections. Public projections deliberately remove private
Curated provenance, so using consumer values alone would lose reviewed-source
restoration. The corrected reader gates native membership and its game, selects
the published preparation, and resolves its audit-retained private entity from
completed checkpoint cutoffs. Correction, Curated and official layers preserve
the existing precedence. Entity/checkpoint/text digests and bounded text lengths
are verified, and a Printing must retain its published owning Card. Native
failures never fall back to legacy rows. The original retained-state validation
then passed in 32 ms; this remains a read-only diagnostic, not completed native
Curated publication or restore evidence.

The existing immutable/audit-retained triggers protect reducer records, text
chunks and checkpoints. These three tables are now explicitly included in the
backup verification census. A nonzero correction pin requires its completed
identity checkpoint; missing authority is unavailable, not an implicit empty
correction set. Runtime-free SQLite regressions cover direct Card/Printing
validation, wrong game/revision, missing/unpublished/retired targets, corrupt
private/checkpoint digests, completed-prefix selection, original-source
restoration and retained text hydration. The native journey now additionally
requires restored owner validation against the Monk's underlying null source
wording after its Curated printed wording has been published.

The separate existing Product/relationship Curated target branch still reads a
legacy whole-candidate document. Its concrete trigger is a field proposal for a
Product (or a relationship proposal) against a native composed Catalogue
Revision. It is outside the Card/Printing correction exercised by #232 and is
reported to the coordinator as a remaining shared Curated integration gap.
No Product/relationship native completion is claimed here.

The frozen `f60fef3` follow-up passed all 39 tests in the four Curated Worker
files, then stopped the native continuation after 152.30 seconds with
`internal_error` at the same first validation request. No Curated Revision was
created; runtimes stopped. The existing Worker files use the test pool and did
not prove native request-time code-generation restrictions. Disabling dynamic
code generation in the read-only validator reproduced an Ajv `EvalError` from
`fieldAjv.compile(schema)` during validation.

Curated field schemas now feed the existing generated standalone-validator
pipeline, including all registered profile property paths. Request handling
selects a precompiled validator and still performs complete-entity checks.
Unknown schemas fail closed. The code-generation-disabled regression passed
after failing on the old request-time compiler; direct field checks preserve
calendar dates, types, vocabulary, required/closed objects and uniqueness.
A minimal actual Worker/D1 diagnostic and regression remain required to confirm
native behavior, distinct from these runtime-free results.

Frozen `1189b1a` supplied the minimal native proof: the exact prior `f60fef3`
validator bundled against the retained D1 returned `EvalError` with dynamic code
generation rejected. The corrected validator returned HTTP 200 for the same
Monk proposal. A real Workerd/D1 regression passed the native published Printing,
wrong-type rejection and unsupported-field rejection in 732 ms. Both native
processes and the regression runtime stopped. The four existing Curated Worker
files had passed 39/39; the runtime-free suite now passes 230 domain tests.

## Integration of the schema-27 handoff protocol

Actual main `396d1eab7a850460b3f1d52d871fe516ec3d9420` integrates the fresh-baseline
handoff protocol at schema 27. Riftbound now follows it as migration
`0028_riftbound_catalogue.sql`, strictly requiring level 27. The populated
rehearsal first caught the loss of handoff triggers during CHECK-table rebuilds;
the migration now restores all 18 handoff mutation triggers on the six rebuilt
tables. It preserves all prior rows, inbound foreign keys, and the complete
trigger census, including the handoff guards. The shared request queue from
main now owns CLI, helper and poll pacing; Riftbound's direct administration and
export reads use that same queue without a duplicate pre-CLI delay.

The earlier AUyRnJ evidence and verified SQL import remain at their genuine
schema 26. They are retained as historical proof and are not relabelled as
schema 27 or 28. A fresh native journey is required on the reconciled migration
chain; earlier functional successes and exact failures remain recorded above.

### Native Product and relationship Curated authority extension

After merging schema-27 main as `7d5b289`, native Curated target resolution now also reads Products, Distribution Contexts, Errata, nested Releases, and exact Product Relationship endpoint pairs. It reconstructs all completed Product reduction layers in reverse `official_errata.productGames` order, then inherited Products. Published membership, private content digests, retained cutoffs, endpoint ownership, and reviewed-source restoration remain mandatory; no legacy candidate hydration is used for native targets.

The focused SQLite suite passes 20 tests, including missing/incomplete/corrupt Product authority, Erratum fields, later-game relationship overlays, and backup/restore source-presence preservation. The fresh schema-28 fixture now includes Product and relationship creation/supersession and restored source validation. These new native lifecycle steps are prepared but not yet executed; the earlier schema-26 state remains historical evidence only.

The cheap actual Workerd/D1 validator regression passed at `611b415` (858 ms), including Product and relationship targets. The subsequent focused Curated Vitest launch stopped during configuration loading before tests ran: Ajv standalone output contained CommonJS runtime-helper `require` calls that Vite rewrote to unsupported file URLs. Direct native ESM import reproduced `ReferenceError: require is not defined`. The generator now bundles those static helpers into its ESM artifact. A direct-import regression, all 20 SQLite Curated tests, and all 230 domain tests pass; the focused Worker suite must be rerun on this fix.

### Fresh schema-28 publication and Curated lifecycle (`a56ec52`)

The fresh run retained at `keepr-real-riftbound-Ny6bhI` completed collection, 36 owner admissions, initial publication and verified SQL import, consumer reads, six Curated operations (Card/Printing creation plus Product and relationship creation/supersession), and a second publication. The renamed Product appeared in its public export. After 1,163 seconds the new relationship assertion failed because the fixture requested internal `product_relationships`; public export descriptors use `relationships`. The assertion also incorrectly expected private `evidence_category`, which consumer projection omits.

Read-only inspection established the exact edge in private reducer state and published membership. A targeted native API boot then verified the Printing's Product link and public component `riftbound.364` for revision `catrev_e1e16719-91a2-45f9-9358-10ddabf712af`, including compressed/content SHA-256, exact relationship ID/endpoints, and `lifecycle.current: true`. No production change was needed. Both runtimes stopped; the original database and verified imports remain preserved.

The fixture now checks the public contract and supports continuation from this terminal verified Curated publication. It verifies the six existing Curated records and supersession links without replaying their mutations. Fresh Origins collection and final restoration remain pending. This continuation is distinct from a fresh full-run pass.

### Third publication backup deadline and bounded fixes

The `e558a81` continuation passed retained Curated-operation checks and public Product/relationship/API graph assertions, collected fresh Origins evidence, and published `catrev_f3ae0ae8-3fa3-4703-b359-dda74797dcd8`. At 431 seconds it stopped on the existing 120-second backup wait: the attempt remained `verifying`, phase `imported`, with no failure. Its interrupted local Workflow and database remain untouched; this is not a verified terminal backup.

Read-only profiling of its actual SQL import found 95,139 census queries, including about 65,000 private checkpoint/reducer rows. Local SQL/hash work took 5.0 seconds. Byte-capped pages now reduce this to 46,171 queries with an exactly identical snapshot: at most four candidate rows and 1 MiB of serialized row content, only for the two schema-bounded private tables. Oversized rows fail closed; other tables keep their prior behavior. Gapped/partial-page, changed-record, oversized-payload, and repeated-cursor regressions pass. Native measurements verified the same snapshot in 11.8 seconds through source D1 and 19.6 seconds through the provider boundary; maximum observed provider response was 25,548 bytes.

The retained 223,550,207-byte SQL took 30.0 seconds to process and 61.9 seconds to import because the local fixture autocommitted every statement. One transaction per disposable import reduces the measured import to 2.5 seconds; SQL processing remains 29.3 seconds. Regression checks prove rollback on invalid SQL, foreign-key restoration, and committed rows after an injected lost response. Review cleared both changes. The measured phases total about 64 seconds; the existing 120-second deadline is unchanged. A new complete fresh run is still required for terminal backup and final restore proof.


### Confirmed local disk exhaustion (`89bfefc`)

The fresh run at `keepr-real-riftbound-U9SSpJ` completed collection, owner admissions,
first publication and verified backup, six Curated operations, and the second
publication. It stopped after 1,042 seconds while the second backup remained
`exporting`. This is not a terminal backup or restore pass.

The actual runtime log contains `pwrite: No space left on device`, followed by
SQLite `SQLITE_IOERR_SHMSIZE` and `SQLITE_CANTOPEN`. Read-only inspection found
search ready and the recovery fence clear: export cleanup had completed before
SQL retention failed. The source dump was 188,687,716 bytes and finished about
12 seconds after the backup step began. The initial search for Worker errors
missed the filesystem errors; the disk error supersedes the earlier tentative
export-performance explanation for this run.

An isolated probe using that exact saved SQL and the shipped provider, SHA
transform, FixedLengthStream, and native R2 retained 188,687,437 transformed bytes
in 34.8 seconds (SHA-256
`75721056afd01412d95cd523899ab63ac706ce5ed2d8d74228e0b5c8bd46f8af`). A sequential
probe retained its first export and upload, then reproduced `No space left on
device` during its second R2 write, after the provider returned in 38.4 seconds.
The volume reported only 318 MiB available. Both probes stopped; disposable probe
output was removed while logs and the original failure state were preserved.
No timeout, backup ledger, or production code was changed for this failure.
Further native gates require adequate disk capacity. The complete fresh journey,
final restoration, and five-game recovery gate remain unverified.


### Complete fresh native proof (`445d4ce`)

After capacity was reclaimed, the complete fresh Riftbound journey passed in
1,222 seconds. It retained 14 initial snapshots and 15 across the journey,
1,260 observations, 1,189 inventory records and nine Products. Six Printing
admissions plus 30 Card-only admissions, six Curated operations, all three
publications and verified backups, fresh Origins evidence, and the final actual
SQL restoration checks passed. Restored exports, image bytes, Product and
relationship effects, reviewed source values, and both source evidence histories
were verified. The successful run cleaned only its new disposable state.
The full log is `/tmp/riftbound-native-capacity-fresh.log`.

The separate five-game fixture initially timed out waiting for its first native
candidate. Its single-game synthetic adapter had correctly reached legacy
`awaiting_approval`; the fixture had selected the wrong dispatch path. The fixture
now declares one five-game collection, then publishes each native candidate
independently and retains the three subsequent Riftbound preparations. A focused
Worker regression passes both two- and five-game dispatch, sealed candidate
identities and parent replay (four tests in the file). The full five-game replay
must pass separately; the first failed state is preserved at
`keepr-five-game-restore-mREWV5`.


### Final branch gates and coverage ledger

The corrected five-game journey passed on `7292bc9` in 63.7 seconds: five
independent publications, three later Riftbound preparations, unchanged sibling
components, current-plus-two reads, retired-revision rejection, and the same
checks after actual SQL restoration. Production code is unchanged since the
fresh Riot proof on `445d4ce`; the intervening changes affect only the five-game
fixture, its dispatch regression, and this evidence document.

Final validation on `7292bc9`:

- API Workers: 95/95 tests passed across 13 files.
- Ingestion Workers with `--maxWorkers=2`: 705/706 passed across 83 files. The
  identity-corrections test “reviewed identity lookup prepare through durable
  bounded groups” failed with `Immutable evidence object key collision`. The
  exact case then passed unchanged, and the complete identity-corrections file
  passed 11/11 unchanged. The collision remains unexplained; it is not claimed
  fixed or attributed to a baseline flake. The earlier unrestricted run was
  interrupted and is not counted as a pass.
- Serial acceptance: 60/60 tests across 26 files passed. This includes every
  changed acceptance file except the two independently passing native journeys,
  all direct consumers of the changed native recovery/catalogue helpers, and
  Curated CLI/source-change and SQL-restore callers. Other unchanged acceptance
  files retain main's baseline coverage and were not rerun on this branch.
- Domain: 232/232 tests across 41 files passed.
- TypeScript, generated Worker types and documents, module boundary/cycle checks,
  formatting, lint, and API/ingestion packaging dry runs passed. Lint reports
  29 warnings and 13 informational findings; no lint errors.
- Read-only standards and specification reviews found no remaining actionable
  blockers, including a follow-up review of the five-game fixture correction.

Logs: `/tmp/riftbound-five-game-native-final.log`, `/tmp/riftbound-final-api.log`,
`/tmp/riftbound-final-ingestion-2.log`, `/tmp/riftbound-identity-collision-isolated.log`,
`/tmp/riftbound-identity-collision-file.log`, `/tmp/riftbound-final-acceptance.log`,
and `/tmp/riftbound-final-checks.log`. The explicit 26-file list is retained at
`/tmp/riftbound-final-acceptance-files.json`. No deployment, resource provisioning,
production enablement, backup-ledger repair, or deletion of prior failure evidence
was performed.
