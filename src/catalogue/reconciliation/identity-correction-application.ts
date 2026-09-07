import { AdministrationProblem, type CatalogueCandidate, type CatalogueStore, canonicalJson } from "../shared";
import type { IdentityCorrectionProposal } from "./identity-corrections";
import type { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import type { ReconciliationRecordCollection } from "./reconciliation-record-collection";
import {
  correctionDecisionPinMetadata,
  pinnedCardIdentityResolver,
  pinnedCorrectionRows,
} from "./identity-correction-pins";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";

type Stage =
  | "decisions"
  | "retire"
  | "printings"
  | "images"
  | "relationships"
  | "errata"
  | "warning"
  | "links"
  | "complete";
type Cursor = {
  stage: Stage;
  sequence: number;
  source: number;
  after: string;
  replacement: number;
  affected: number;
  chain: { resolved: string; visited: string[] } | null;
  excludedImages: string[];
  excludedRelationships: string[];
  excludedErrata: string[];
  processedDecisions: number;
  positions: ReconciliationCandidateState["positions"];
  warnings: ReconciliationRecordCollection<Record<string, unknown>>["cursor"];
};

/** Apply each reviewed retirement and dependent-entity check from its completed prefix. */
export async function applyPinnedIdentityCorrectionsToDraft(
  database: CatalogueStore,
  runId: string,
  draft: ReconciliationCandidateState,
  warnings: ReconciliationRecordCollection<Record<string, unknown>>,
  yieldAtCheckpoint = false,
): Promise<void> {
  if ((await correctionDecisionPinMetadata(database, runId)).decision_cutoff === 0) return;
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "identity_application");
  const cursor: Cursor = checkpoint?.value ?? {
    stage: "decisions",
    sequence: 0,
    source: 0,
    after: "",
    replacement: 0,
    affected: 0,
    chain: null,
    excludedImages: [],
    excludedRelationships: [],
    excludedErrata: [],
    processedDecisions: 0,
    positions: draft.positions,
    warnings: warnings.cursor,
  };
  draft.resumeAt(cursor.positions);
  warnings.resumeAt(cursor.warnings);
  if (cursor.stage === "complete") return;
  const correctedCardIdentity = await pinnedCardIdentityResolver(database, runId);
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let work = 0,
    bytes = 0;
  const save = async () => {
    cursor.positions = draft.positions;
    cursor.warnings = warnings.cursor;
    await retainReconciliationCheckpoint(database, runId, "identity_application", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "identity_application", ordinal });
    ordinal++;
    work = 0;
    bytes = 0;
  };
  const before = async (record: unknown) => {
    const size = new TextEncoder().encode(canonicalJson(record)).byteLength;
    if (work && bytes + size > 512000) await save();
    bytes += size;
  };
  const tick = async (limit = 4) => {
    if (++work >= limit || bytes >= 512000) await save();
  };
  const advance = async (stage: Stage) => {
    cursor.stage = stage;
    cursor.after = "";
    await save();
  };
  const countAffected = () => {
    if (++cursor.affected > 500)
      throw new Error("reconciliation_capacity_exceeded: one correction affects too many dependent entities.");
  };
  if (cursor.stage !== "links") {
    for await (const row of pinnedCorrectionRows(database, runId, cursor.sequence)) {
      const decision = JSON.parse(row.request_json) as IdentityCorrectionProposal;
      if (cursor.stage === "decisions") {
        cursor.source = 0;
        cursor.affected = 0;
        cursor.excludedImages = [];
        cursor.excludedRelationships = [];
        cursor.excludedErrata = [];
        if (decision.action === "assign") {
          await before(decision);
          await warnings.push({
            code: "identity_assignment",
            correction_id: row.id,
            printing_assignments: decision.printing_assignments,
            detail: "Owner assigned retained Printings to a reviewed replacement Card without changing Printing IDs.",
          });
          cursor.sequence = row.sequence;
          cursor.processedDecisions++;
          await tick();
          continue;
        }
        cursor.stage = "retire";
      }
      if (decision.action === "assign")
        throw new Error("Identity application checkpoint names an invalid assignment stage.");
      const retired = new Set(decision.source_ids);
      if (cursor.stage === "retire") {
        const ids = [...retired];
        while (cursor.source < ids.length) {
          const id = ids[cursor.source]!;
          await before({ id, replacement_ids: decision.replacement_ids });
          await draft.set("identity_corrections", {
            id,
            game: decision.game as CatalogueCandidate["selected_games"][number],
            entity_kind: decision.entity_kind,
            action: decision.action,
            replacement_ids: decision.replacement_ids,
          });
          await draft.delete(decision.entity_kind === "card" ? "cards" : "printings", id);
          cursor.source++;
          await tick();
        }
        await advance("printings");
      }
      if (cursor.stage === "printings") {
        if (decision.entity_kind === "card")
          for await (const printing of draft.values("printings", cursor.after)) {
            await before(printing);
            if (retired.has(printing.card_id)) {
              if (!cursor.chain) {
                countAffected();
                cursor.chain = { resolved: printing.card_id, visited: [] };
              }
              const chain = cursor.chain;
              for (;;) {
                const next = await correctedCardIdentity.next(chain.resolved, printing.id);
                if (!next || next === chain.resolved) break;
                if (chain.visited.length === 32)
                  throw new Error("reconciliation_capacity_exceeded: one identity correction chain exceeds 32 links.");
                if (chain.visited.includes(next)) throw new Error("Retained identity correction cycle.");
                chain.visited.push(chain.resolved);
                chain.resolved = next;
                await tick();
              }
              const resolved = chain.resolved;
              if (resolved !== printing.card_id) await draft.set("printings", { ...printing, card_id: resolved });
              else {
                await draft.delete("printings", printing.id);
                await warnings.push({
                  code: "identity_correction_exclusion",
                  detail: `Printing ${printing.id} has no reviewed split assignment and is excluded pending owner review.`,
                  printing_id: printing.id,
                  correction_id: row.id,
                });
              }
            }
            cursor.chain = null;
            cursor.after = printing.id;
            await tick();
          }
        await advance("images");
      }
      if (cursor.stage === "images") {
        for await (const image of draft.values("printing_images", cursor.after)) {
          await before(image);
          if (!(await draft.has("printings", image.printing_id))) {
            countAffected();
            cursor.excludedImages.push(image.id);
            await draft.delete("printing_images", image.id);
          }
          cursor.after = image.id;
          await tick();
        }
        await advance("relationships");
      }
      if (cursor.stage === "relationships") {
        const validEndpoint = async (endpoint: { type: string; id: string }) =>
          endpoint.type === "card"
            ? await draft.has("cards", endpoint.id)
            : endpoint.type === "printing"
              ? await draft.has("printings", endpoint.id)
              : true;
        for await (const relationship of draft.values("product_relationships", cursor.after)) {
          await before(relationship);
          if (!(await validEndpoint(relationship.from)) || !(await validEndpoint(relationship.to))) {
            countAffected();
            cursor.excludedRelationships.push(relationship.id);
            await draft.delete("product_relationships", relationship.id);
          }
          cursor.after = relationship.id;
          await tick();
        }
        await advance("errata");
      }
      if (cursor.stage === "errata") {
        for await (const erratum of draft.values("errata", cursor.after)) {
          await before(erratum);
          if (!(await draft.has(erratum.target_type === "card" ? "cards" : "printings", erratum.target_id))) {
            countAffected();
            cursor.excludedErrata.push(erratum.id);
            await draft.delete("errata", erratum.id);
          }
          cursor.after = erratum.id;
          await tick();
        }
        await advance("warning");
      }
      if (cursor.stage === "warning") {
        await warnings.push({
          code: "identity_correction",
          correction_id: row.id,
          detail: `Reviewed ${decision.action}: retired identities retain consumer replacement links.`,
          source_ids: decision.source_ids,
          replacement_ids: decision.replacement_ids,
          exclusions: {
            printing_image_ids: cursor.excludedImages,
            relationship_ids: cursor.excludedRelationships,
            erratum_ids: cursor.excludedErrata,
          },
        });
        cursor.sequence = row.sequence;
        cursor.processedDecisions++;
        await advance("decisions");
      }
    }
    await advance("links");
  }
  if (cursor.stage === "links") {
    for await (const correction of draft.values("identity_corrections", cursor.after)) {
      while (cursor.replacement < correction.replacement_ids.length) {
        const id = correction.replacement_ids[cursor.replacement]!;
        if (
          !(await draft.has(correction.entity_kind === "card" ? "cards" : "printings", id)) &&
          !(await draft.has("identity_corrections", id))
        )
          throw new AdministrationProblem(
            409,
            "identity_correction_target_unavailable",
            "A reviewed replacement is unavailable; reconciliation cannot publish dangling correction links.",
          );
        cursor.replacement++;
        await tick();
      }
      cursor.after = correction.id;
      cursor.replacement = 0;
      await tick();
    }
    await advance("complete");
  }
}
