# Reconciliation ownership audit (#225)

This audit covers the collection/preparation separation through schema 20. It
inventories foreign keys to `ingestion_runs`, `source_snapshots`, and
`source_observation_sets`, then traces their repository writers from the native
preparation entry point. It also checks retained JSON and Workflow parameters
whose provenance is not enforced by a foreign key. Historical tables replaced
by later migrations are identified separately from live writers.

`reconciliation_operations.id` owns preparation work. Its immutable
`ingestion_run_id` identifies the real source collection. Native operations use
different IDs; the legacy compatibility operation uses the collection ID for
both. Source Snapshot and Source Observation Set IDs always identify retained
source evidence, never preparation artifacts.

## Collection and source foreign keys

| Tables / fields | Write callers | Native preparation treatment |
| --- | --- | --- |
| `ingestion_runs.linked_run_id`; `ingestion_run_events`, `ingestion_run_current`, `ingestion_run_selected_games` | Shared ingestion event recipes, source-evidence lifecycle, legacy run finalization/publication | Native preparation does not append collection transitions. Its creation and terminal paths write its operation/candidate instead. |
| `ingestion_evidence_plans`, `source_requests`, `source_snapshots.ingestion_run_id` | Source-plan, capture, and evidence-run repositories | Read through the operation's real collection ID. Native preparation does not add collection requests or captures. |
| `source_capture_operations.reused_source_snapshot_id`, `source_snapshots.reused_source_snapshot_id`, `source_parse_operations.source_snapshot_id`, `source_observation_sets.source_snapshot_id`, `official_source_collection_plans` | Source capture, parse, and collection-plan repositories | Source IDs remain source IDs. Native verification reads the frozen observations and immutable capture/image references. |
| Collection capacity/retry/workflow pause and extension tables, `ingestion_workflow_attempts`, `ingestion_run_terminations`, `ingestion_collection_reservations` | Source-evidence control and shared reservation recipes | Collection-owned; native pause/resume/failure does not write these. Automatic collection dispatch/reservation completion is still a separate integration task. |
| `reconciliation_operations.ingestion_run_id`, `game_candidates.ingestion_run_id`, `game_candidate_slots.ingestion_run_id` | `createGamePreparationStatement`; legacy operation/candidate recipes | Deliberate dual identity: artifacts and slot ownership bind the preparation, while these fields retain the real collection. Native creation inserts them atomically. |
| `canonical_source_mappings` | `insertSourceMappingsStatement` | Legacy insertion requires `supported_game IS NULL`. Native mappings go to `reconciliation_source_mappings`, keyed by preparation/entity/observation. A published collection cannot grant publication authority to new native mappings. |
| `reconciliation_source_mappings` source collection/snapshot/observation-set FKs | Native branch of `insertSourceMappingsStatement` | Collection ID is selected from the operation. Snapshot and observation-set IDs come from frozen source observations. Owner inspection accepts `preparation_id`; staged mappings remain outside the published index. |
| `entity_proposal_source_evidence` | `assessSourceAdmission` → `retainProposalEvidenceStatement` | Fixed: the writer resolves preparation ID to the real collection before retaining shared proposal evidence. The generation-fenced preparation remains the writer authorization. |
| `canonical_identity_reviews`, `canonical_identity_review_runs` | Canonical matching → `insertIdentityReviewStatement` | Fixed: both collection FKs resolve through the operation. Native membership is additionally retained in immutable `reconciliation_identity_reviews`, keyed by preparation/review. Owner inspection can select that preparation. |
| `ingestion_run_curated_revisions`, `ingestion_run_curated_revision_sets` | Collection/run creation's curated pin recipes | Native preparation reads the selected game's immutable collection pin set through its real collection ID; it does not insert a fictitious run pin. Curated conflict work is preparation-owned. |
| `entity_admission_run_pins`, `identity_correction_run_pins` | Historical schema 18/19 writers | Read-only historical compatibility inputs. New pins use preparation-owned tables. Historical selection/cutoff reuse is limited to legacy operations. |
| `reconciliation_contexts`, `reconciliation_candidates`, `reconciliation_evidence_partitions`, `reconciliation_payload_chunks`, `reconciliation_workflow_requests`, `reconciliation_terminal_results` | Legacy candidate staging, run Workflow request/result recipes | Native success and semantic failure bypass legacy candidate staging; native integrity/capacity/expiry failures bypass legacy run terminal records. Native requests/outcomes have their own preparation ownership. |
| `catalogue_revisions`, `ingestion_no_change_results`, `ingestion_publication_cleanup`, source freshness tables, `reconciled_withdrawal_assertions`, `catalogue_backup_attempts.publication_ingestion_run_id` | Publication commit, freshness, cleanup, backup/recovery repositories | Not native preparation writers. Native publication integration must consume the retained candidate under its own publication authority. |
| Historical `ingestion_run_transitions`, eligibility tables, replaced freshness/context layouts | Historical migrations / replacement projections | No new native writer. The audit does not reintroduce removed eligibility behavior. |

## Preparation-owned records

The operation ID owns admission/correction pins, input/record partitions,
observation origins, source byte/document/text chunks, game entity scopes,
reducer/sort state, curated conflicts, checkpoints, normalized source
observations, evidence selection, work receipts, action receipts, native
Workflow requests, mapping/review staging, and terminal outcomes. Child game
partitions bind their candidate ID. These records do not use collection state
as preparation ownership or publication authority.

The native terminal transaction updates only the operation, its candidate
metadata/state, and its own slot. Ordinary native writes require the retained
generation, preparing state, original deadline, expected game head, and owned
slot. Terminal failure relaxes the deadline/head checks to record the failure,
while preserving generation/state and recovery fencing.

## Non-FK provenance and decision reads

- Workflow parameters/results, native outcomes, and owner candidate inspection
  distinguish `preparation_id` from the actual collection `run_id` or
  `ingestion_run_id`.
- `SourceMapping.runId` is the actual collection. Large mapping evidence retains
  source observation, observation-set, snapshot, and digest references.
- Curated conflict identity/details retain the actual collection plus native
  preparation ID. Conflict visibility follows the failed native operation;
  legacy conflict visibility continues to follow the legacy run.
- Canonical allocation keys and automatic admission idempotency keys are
  decision identities, not collection foreign keys. Allocation alone does not
  make an entity published. Automatic admission keys include their preparation.
- Existing unresolved proposals retain a generation-zero selection row. The
  pinned decision query's left join preserves that row, so a later owner link
  does not replace the preparation's unresolved decision. The owner-interface
  regression verifies this alongside the retained later owner decision.
- Policy generations are checked against the operation's authority cutoff in
  the creation transaction. An intervening authority mutation rolls creation
  back; exact concurrent creation reuses the winner's identity and deadline.

## Remaining integration boundary

This closes the identified source/preparation foreign-key bridges; it is not
final #225 acceptance. Production collection/owner dispatch, runtime resource
limits, stress performance, and final verification remain on the finite
acceptance checklist. When collection reservations are released before native
preparation, recheck the new-proposal automation fallback: it must not adopt an
owner decision written after the preparation's snapshot. Existing proposal
pins and their late-link regression already cover the retained-proposal case.

Native curated selection currently inherits the collection's immutable pin set.
This preserves replay, but does not yet prove that a fresh preparation over the
same evidence can pin an owner reaffirmation made after that collection. The
production integration must test that lifecycle and give each fresh native
preparation its own exact curated selection while retaining old pins on resume.
The current native conflict test still encounters the collection reservation
when attempting reaffirmation; it does not establish that lifecycle as complete.

Native mapping publication is downstream work (#226/#227). It must consume
preparation-owned evidence and gate published visibility on candidate
publication, never on the source collection's publication state.
