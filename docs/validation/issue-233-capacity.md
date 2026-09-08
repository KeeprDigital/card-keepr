# Issue 233 capacity and fault evidence

Campaign base: `0bb3b7d26c6744b4c037d788e6b45c334ae8aa83`, schema 28.
This is an initial acceptance/evidence matrix, not a passing capacity report.
Heavy campaigns run serially with a frozen commit and a fresh `/tmp` filesystem
preflight. Historical issue 232 failure states remain owned by the coordinator.

| Accepted requirement | Existing evidence at base | Campaign gap / action |
| --- | --- | --- |
| 128 × 100 KiB image pipeline | `reconciliation-scale.stress.spec.ts` collects 16 documents, checks 128 immutable references / 13,107,200 bytes, and approves | Run unchanged reproduction; report actual outcome and census |
| 10,000 Printings / 20,000 images / 5 GiB images / 100 MiB structured data | No matching executable tier found | Add explicit tier replay; distinguish admission/guard failure from successful completion; avoid materializing entire generated input |
| 100,000 Printings / 200,000 images / 50 GiB images / 1 GiB structured data | No matching executable tier found | Same; local disk is a separate campaign constraint, never an application capacity result |
| Complete declared P-001 | `issue-231-one-piece.md`: six publications and actual restored consumer/image verification at `a46aeb8`; 703 s | Run final P-001 command with expanded metrics; retain bounded source declaration and label disappearance/outage injection |
| Actual Riftbound | `riftbound-native.md`: full journey `445d4ce`, 1,222 s; five-game composition/restore `7292bc9`, 63.7 s | Run final actual-source command with expanded metrics; reuse independent five-game proof unless affected |
| CPU / working set / calls / D1 and index amplification / concurrent occupancy / owner actions / billed dimensions | P-001 driver CPU/RSS, statement preparations, batch submissions, table/index allocation | Instrument execution and occupancy; driver CPU/RSS cannot stand in for isolate metrics; unavailable billed/platform dimensions remain explicit gaps |
| Product-heavy duration | Legacy base failed 15 s polling; native base 15,198 ms and inspection head 16,350 ms; max 78 calls | Reproduce both unchanged deadlines with phase diagnostics before tuning; unresolved timing is failure |
| Durable collection interruption and lost writes | `runtime-storage-recovery.spec.ts`, `runtime-collection-batch-replay.spec.ts`, `runtime-workflow-recovery.spec.ts` | Audit exact boundaries and use existing cases; no duplicate harness for proven boundaries |
| Reconciliation interruption / commit replay | `reconciliation-progress.spec.ts`, `reconciliation-shards.spec.ts`, `reconciliation-workflow-binding.spec.ts` | Map retained stages, reservations and lost commit output against native flow |
| Preparation retry / corruption / stale writer | `publication-preparation.spec.ts`: partial upload exhaustion/resume, image/projection/composition corruption, stale sequence, abandoned owner, deadline, old dispatch | Reuse cases; add only uncovered durable boundaries |
| Approval replay / expiry / contention / atomic switch | `game-publication.spec.ts`, `game-publication-workflow.spec.ts`, `game-reconciliation-fences.spec.ts` | Audit expiry after approval/backup wait and unrelated-game contention; preserve exact approval/deadline |
| Backup failure / lost export or import response / recovery fence | `backup-recovery.spec.ts`, `composed-recovery.spec.ts`, `recovery.spec.ts`; native real journeys prove actual SQL export/import | Reuse injected faults; retain separate actual restore proof; never manufacture verified checkpoints |
| Cleanup race / retention / late writers | `evidence-cleanup.spec.ts`: exact 30 days, reference acquisition, ambiguous deletion, multipart abort, old ticket incarnation, paused/shared/historical evidence | Reuse full fault file and preserve current-plus-two/export/backup retention |

Existing evidence is historical provenance, not a new run result. The issue 232
identity immutable-key collision remains unexplained: 705/706 full ingestion,
then exact case and complete 11-test file passed unchanged. It is not a fix.

No dollar estimate, completion SLA, isolate headroom claim, deployment, resource
provisioning, live cleanup, release-gate waiver, merge, or issue closure is part
of this initial matrix.
