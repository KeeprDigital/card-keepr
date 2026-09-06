import { ReconciliationReducerIndex, ReconciliationReducerStorageError } from "./reconciliation-reducer-state";
import type { IdentityCorrectionProposal } from "./identity-corrections";
import {
  AdministrationProblem,
  type CatalogueCandidate,
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
  await correctionDecisionPinMetadata(database, runId);
  const correctedCardIdentity = await pinnedCardIdentityResolver(database, runId);
  const cards = new Map(candidate.cards.map((c) => [c.id, c]));
  const printings = new Map(candidate.printings.map((p) => [p.id, p]));
  const corrections = new Map((candidate.identity_corrections ?? []).map((c) => [c.id, c]));
  let images = [...(candidate.printing_images ?? [])];
  let relationships = [...(candidate.product_relationships ?? [])];
  let errata = [...(candidate.errata ?? [])];
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
    // Replaying a retained correction suppresses any re-observed old alias;
    // the historical source mapping remains attached to that original ID.
    for (const id of retired) {
      corrections.set(id, {
        id,
        game: decision.game as CatalogueCandidate["selected_games"][number],
        entity_kind: decision.entity_kind,
        action: decision.action,
        replacement_ids: decision.replacement_ids,
      });
      if (decision.entity_kind === "card") cards.delete(id);
      else printings.delete(id);
    }
    if (decision.entity_kind === "card") {
      for (const [id, printing] of printings) {
        if (!retired.has(printing.card_id)) continue;
        const resolved = await correctedCardIdentity(printing.card_id, id);
        const target = resolved === printing.card_id ? undefined : resolved;
        if (target) printings.set(id, { ...printing, card_id: target });
        else {
          printings.delete(id);
          warnings.push({
            code: "identity_correction_exclusion",
            detail: `Printing ${id} has no reviewed split assignment and is excluded pending owner review.`,
            printing_id: id,
            correction_id: row.id,
          });
        }
      }
    }
    const excludedImages = images.filter((i) => !printings.has(i.printing_id));
    const validEndpoint = (e: { type: string; id: string }) =>
      e.type === "card" ? cards.has(e.id) : e.type === "printing" ? printings.has(e.id) : true;
    const excludedRelationships = relationships.filter((r) => !validEndpoint(r.from) || !validEndpoint(r.to));
    const excludedErrata = errata.filter((e) =>
      e.target_type === "card" ? !cards.has(e.target_id) : !printings.has(e.target_id),
    );
    images = images.filter((i) => printings.has(i.printing_id));
    relationships = relationships.filter((r) => validEndpoint(r.from) && validEndpoint(r.to));
    errata = errata.filter((e) => (e.target_type === "card" ? cards.has(e.target_id) : printings.has(e.target_id)));
    warnings.push({
      code: "identity_correction",
      correction_id: row.id,
      detail: `Reviewed ${decision.action}: retired identities retain consumer replacement links.`,
      source_ids: decision.source_ids,
      replacement_ids: decision.replacement_ids,
      exclusions: {
        printing_image_ids: excludedImages.map((i) => i.id),
        relationship_ids: excludedRelationships.map((r) => r.id),
        erratum_ids: excludedErrata.map((e) => e.id),
      },
    });
  }
  // Correction chains may lead to another retired identity (including a split).
  // Consumers follow the links and retain the choice; never collapse a split.
  for (const correction of corrections.values())
    for (const id of correction.replacement_ids) {
      if (!(correction.entity_kind === "card" ? cards.has(id) : printings.has(id)) && !corrections.has(id))
        throw new AdministrationProblem(
          409,
          "identity_correction_target_unavailable",
          "A reviewed replacement is unavailable; reconciliation cannot publish dangling correction links.",
        );
    }
  return {
    ...candidate,
    cards: [...cards.values()],
    printings: [...printings.values()],
    printing_images: images,
    product_relationships: relationships,
    errata,
    ...(corrections.size
      ? { identity_corrections: [...corrections.values()].sort((a, b) => a.id.localeCompare(b.id)) }
      : {}),
  };
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
