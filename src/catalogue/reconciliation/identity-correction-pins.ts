import { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import { ReconciliationReducerIndex, ReconciliationReducerStorageError } from "./reconciliation-reducer-state";
import type { IdentityCorrectionProposal } from "./identity-corrections";
import {
  AdministrationProblem,
  type CatalogueCandidate,
  type CatalogueDraft,
  type CatalogueStore,
  canonicalJson,
  sha256Text,
} from "../shared";
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
export async function applyPinnedIdentityCorrections(
  database: CatalogueStore,
  runId: string,
  candidate: CatalogueCandidate,
  warnings: Record<string, unknown>[],
) {
  const pin = await correctionDecisionPinMetadata(database, runId);
  if (pin.decision_cutoff === 0) return candidate;
  const draft = new ReconciliationCandidateState(database, runId, "corrections");
  await draft.seed(candidate, [
    "cards",
    "printings",
    "printing_images",
    "product_relationships",
    "errata",
    "identity_corrections",
  ]);
  await applyPinnedIdentityCorrectionsToDraft(database, runId, draft, warnings);
  return draft.candidate(candidate);
}

export async function applyPinnedIdentityCorrectionsToDraft(
  database: CatalogueStore,
  runId: string,
  draft: CatalogueDraft,
  warnings: Record<string, unknown>[],
): Promise<void> {
  const correctedCardIdentity = await pinnedCardIdentityResolver(database, runId);
  for await (const row of pinnedCorrectionRows(database, runId)) {
    const decision = JSON.parse(row.request_json) as IdentityCorrectionProposal;
    if (decision.action === "assign") {
      warnings.push({
        code: "identity_assignment",
        correction_id: row.id,
        printing_assignments: decision.printing_assignments,
        detail: "Owner assigned retained Printings to a reviewed replacement Card without changing Printing IDs.",
      });
      continue;
    }
    const retired = new Set(decision.source_ids);
    for (const id of retired) {
      await draft.set("identity_corrections", {
        id,
        game: decision.game as CatalogueCandidate["selected_games"][number],
        entity_kind: decision.entity_kind,
        action: decision.action,
        replacement_ids: decision.replacement_ids,
      });
      await draft.delete(decision.entity_kind === "card" ? "cards" : "printings", id);
    }
    let affected = 0;
    const countAffected = () => {
      if (++affected > 500)
        throw new Error("reconciliation_capacity_exceeded: one correction affects too many dependent entities.");
    };
    if (decision.entity_kind === "card") {
      for await (const printing of draft.values("printings")) {
        if (!retired.has(printing.card_id)) continue;
        countAffected();
        const resolved = await correctedCardIdentity(printing.card_id, printing.id);
        if (resolved !== printing.card_id) await draft.set("printings", { ...printing, card_id: resolved });
        else {
          await draft.delete("printings", printing.id);
          warnings.push({
            code: "identity_correction_exclusion",
            detail: `Printing ${printing.id} has no reviewed split assignment and is excluded pending owner review.`,
            printing_id: printing.id,
            correction_id: row.id,
          });
        }
      }
    }
    const excludedImages: string[] = [];
    for await (const image of draft.values("printing_images")) {
      if (await draft.has("printings", image.printing_id)) continue;
      countAffected();
      excludedImages.push(image.id);
      await draft.delete("printing_images", image.id);
    }
    const validEndpoint = async (endpoint: { type: string; id: string }) =>
      endpoint.type === "card"
        ? await draft.has("cards", endpoint.id)
        : endpoint.type === "printing"
          ? await draft.has("printings", endpoint.id)
          : true;
    const excludedRelationships: string[] = [];
    for await (const relationship of draft.values("product_relationships")) {
      if ((await validEndpoint(relationship.from)) && (await validEndpoint(relationship.to))) continue;
      countAffected();
      excludedRelationships.push(relationship.id);
      await draft.delete("product_relationships", relationship.id);
    }
    const excludedErrata: string[] = [];
    for await (const erratum of draft.values("errata")) {
      if (await draft.has(erratum.target_type === "card" ? "cards" : "printings", erratum.target_id)) continue;
      countAffected();
      excludedErrata.push(erratum.id);
      await draft.delete("errata", erratum.id);
    }
    warnings.push({
      code: "identity_correction",
      correction_id: row.id,
      detail: `Reviewed ${decision.action}: retired identities retain consumer replacement links.`,
      source_ids: decision.source_ids,
      replacement_ids: decision.replacement_ids,
      exclusions: {
        printing_image_ids: excludedImages,
        relationship_ids: excludedRelationships,
        erratum_ids: excludedErrata,
      },
    });
  }
  for await (const correction of draft.values("identity_corrections")) {
    for (const id of correction.replacement_ids) {
      if (
        !(await draft.has(correction.entity_kind === "card" ? "cards" : "printings", id)) &&
        !(await draft.has("identity_corrections", id))
      )
        throw new AdministrationProblem(
          409,
          "identity_correction_target_unavailable",
          "A reviewed replacement is unavailable; reconciliation cannot publish dangling correction links.",
        );
    }
  }
}

// Identity corrections only relax the Card association explicitly reviewed by
// the owner. Artwork, printed content, rarity and treatment still must agree.
export async function pinnedCardIdentityResolver(database: CatalogueStore, runId: string) {
  const pin = await correctionDecisionPinMetadata(database, runId);
  if (pin.decision_cutoff === 0) return async (cardId: string, _printingId: string) => cardId;
  const merges = new ReconciliationReducerIndex<string>(database, runId, "correction_merges");
  const assignments = new ReconciliationReducerIndex<string>(database, runId, "correction_assignments");
  for await (const row of pinnedCorrectionRows(database, runId)) {
    merges.beginObservation();
    assignments.beginObservation();
    const decision = JSON.parse(row.request_json) as IdentityCorrectionProposal;
    if (decision.entity_kind !== "card") continue;
    const assignmentsCount = decision.source_ids.length * Object.keys(decision.printing_assignments).length;
    if (decision.source_ids.length + assignmentsCount > 500) {
      throw new Error("reconciliation_capacity_exceeded: one correction decision has too many identity associations.");
    }
    if (decision.action === "merge")
      for (const id of decision.source_ids) await merges.set(id, decision.replacement_ids[0]!);
    for (const source of decision.source_ids)
      for (const [printing, target] of Object.entries(decision.printing_assignments))
        await assignments.set(canonicalJson([source, printing]), target);
  }
  return async (cardId: string, printingId: string) => {
    let resolved = cardId;
    const visited = new Set<string>();
    // A single identity chain is a bounded lookup unit, including at most 66 state reads.
    for (let depth = 0; ; depth++) {
      const next = (await assignments.get(canonicalJson([resolved, printingId]))) ?? (await merges.get(resolved));
      if (!next || next === resolved) break;
      if (depth === 32)
        throw new Error("reconciliation_capacity_exceeded: one identity correction chain exceeds 32 links.");
      if (visited.has(next)) throw new Error("Retained identity correction cycle.");
      visited.add(resolved);
      resolved = next;
    }
    return resolved;
  };
}

async function* pinnedCorrectionRows(database: CatalogueStore, runId: string): AsyncGenerator<CorrectionRow> {
  let after = 0;
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
