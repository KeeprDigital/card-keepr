import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { ReconciliationReducerIndex, ReconciliationReducerStorageError } from "./reconciliation-reducer-state";
import type { IdentityCorrectionProposal } from "./identity-corrections";
import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import {
  correctionPinStatement,
  correctionPinStatementsForNewRun,
  pinnedCorrectionsStatement,
  type CorrectionRow,
} from "./identity-correction-repository";
export { correctionPinStatementsForNewRun } from "./identity-correction-repository";

export async function pinCorrectionDecisions(database: CatalogueStore, runId: string, games: readonly string[]) {
  const expected = canonicalJson([...new Set(games)].sort());
  let existing = await correctionPinStatement(database, runId).first<{ games_json: string; decision_cutoff: number }>();
  if (!existing) {
    try {
      await database.batch(correctionPinStatementsForNewRun(database, runId, games));
      existing = await correctionPinStatement(database, runId).first<{ games_json: string; decision_cutoff: number }>();
    } catch (error) {
      existing = await correctionPinStatement(database, runId).first<{ games_json: string; decision_cutoff: number }>();
      if (!existing) throw error;
    }
  }
  if (existing && existing.games_json !== expected)
    throw new AdministrationProblem(
      409,
      "correction_pin_conflict",
      "The run's correction game selection is immutable.",
    );
}
export async function correctionDecisionPinMetadata(database: CatalogueStore, runId: string) {
  const pin = await correctionPinStatement(database, runId).first<{ games_json: string; decision_cutoff: number }>();
  if (!pin) throw new Error("Correction decisions must be pinned before reconciliation.");
  return { decision_cutoff: pin.decision_cutoff, set_digest: await sha256Text(canonicalJson(pin)) };
}
// Identity corrections only relax the Card association explicitly reviewed by
// the owner. Artwork, printed content, rarity and treatment still must agree.
export async function pinnedCardIdentityResolver(database: CatalogueStore, runId: string, yieldAtCheckpoint = false) {
  const pin = await correctionDecisionPinMetadata(database, runId);
  if (pin.decision_cutoff === 0)
    return Object.assign(async (cardId: string, _printingId: string) => cardId, {
      next: async (_cardId: string, _printingId: string): Promise<string | undefined> => undefined,
    });
  const merges = new ReconciliationReducerIndex<string>(database, runId, "correction_merges");
  const assignments = new ReconciliationReducerIndex<string>(database, runId, "correction_assignments");
  type Cursor = {
    after: number;
    association: number;
    merges: number;
    assignments: number;
    processedDecisions: number;
    complete: boolean;
  };
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "identity_associations");
  const cursor: Cursor = checkpoint?.value ?? {
    after: 0,
    association: 0,
    merges: 0,
    assignments: 0,
    processedDecisions: 0,
    complete: false,
  };
  merges.resumeAt(cursor.merges);
  assignments.resumeAt(cursor.assignments);
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let work = 0,
    bytes = 0;
  const save = async () => {
    cursor.merges = merges.position;
    cursor.assignments = assignments.position;
    await retainReconciliationCheckpoint(database, runId, "identity_associations", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "identity_associations", ordinal });
    ordinal++;
    work = 0;
    bytes = 0;
  };
  if (!cursor.complete) {
    for await (const row of pinnedCorrectionRows(database, runId, cursor.after)) {
      const size = new TextEncoder().encode(row.request_json).byteLength;
      if (size > 512000)
        throw new Error("reconciliation_capacity_exceeded: one correction decision exceeds 512000 metadata bytes.");
      if (work > 0 && (work >= 8 || bytes + size > 512000)) await save();
      bytes += size;
      work++;
      merges.beginObservation();
      assignments.beginObservation();
      const decision = JSON.parse(row.request_json) as IdentityCorrectionProposal;
      if (decision.entity_kind === "card") {
        const assignmentsCount = decision.source_ids.length * Object.keys(decision.printing_assignments).length;
        if (decision.source_ids.length + assignmentsCount > 500)
          throw new Error(
            "reconciliation_capacity_exceeded: one correction decision has too many identity associations.",
          );
        const associations: { kind: "merge" | "assignment"; key: string; target: string }[] = [];
        if (decision.action === "merge")
          for (const id of decision.source_ids)
            associations.push({ kind: "merge", key: id, target: decision.replacement_ids[0]! });
        for (const source of decision.source_ids)
          for (const [printing, target] of Object.entries(decision.printing_assignments))
            associations.push({ kind: "assignment", key: canonicalJson([source, printing]), target });
        while (cursor.association < associations.length) {
          if (work >= 8) {
            await save();
            bytes = size;
          }
          const association = associations[cursor.association]!;
          await (association.kind === "merge" ? merges : assignments).set(association.key, association.target);
          cursor.association++;
          work++;
        }
      }
      cursor.after = row.sequence;
      cursor.association = 0;
      cursor.processedDecisions++;
    }
    cursor.complete = true;
    await save();
  }
  const nextIdentity = async (cardId: string, printingId: string) =>
    (await assignments.get(canonicalJson([cardId, printingId]))) ?? (await merges.get(cardId));
  const resolve = async (cardId: string, printingId: string) => {
    let resolved = cardId;
    const visited = new Set<string>();
    // A single identity chain is a bounded lookup unit, including at most 66 state reads.
    for (let depth = 0; ; depth++) {
      const next = await nextIdentity(resolved, printingId);
      if (!next || next === resolved) break;
      if (depth === 32)
        throw new Error("reconciliation_capacity_exceeded: one identity correction chain exceeds 32 links.");
      if (visited.has(next)) throw new Error("Retained identity correction cycle.");
      visited.add(resolved);
      resolved = next;
    }
    return resolved;
  };
  return Object.assign(resolve, { next: nextIdentity });
}

export async function* pinnedCorrectionRows(
  database: CatalogueStore,
  runId: string,
  after = 0,
): AsyncGenerator<CorrectionRow> {
  while (true) {
    let row: CorrectionRow | null;
    try {
      row = await pinnedCorrectionsStatement(database, runId, after).first<CorrectionRow>();
    } catch (cause) {
      throw new ReconciliationReducerStorageError(cause);
    }
    if (!row) return;
    yield row;
    after = row.sequence;
  }
}
