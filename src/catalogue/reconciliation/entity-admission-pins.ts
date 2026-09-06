import { admissionPolicyDigest } from "./entity-admission-source";
import { sourceAuthorities } from "../source-evidence";
import {
  AdministrationProblem,
  type CatalogueStore,
  type CatalogueCard,
  type CataloguePrinting,
  canonicalJson,
} from "../shared";
import {
  admissionPinStatement,
  pinAdmissionsStatement,
  pinnedAdmissionsStatement,
  type EntityProposalRow,
} from "./entity-admission-repository";

export async function pinEntityAdmissions(database: CatalogueStore, runId: string, games: readonly string[]) {
  const gamesJson = canonicalJson([...new Set(games)].sort());
  const existing = await admissionPinStatement(database, runId).first<{ games_json: string }>();
  if (existing) {
    if (existing.games_json !== gamesJson)
      throw new AdministrationProblem(
        409,
        "admission_pin_conflict",
        "The run's admission game selection is immutable.",
      );
    return;
  }
  try {
    await pinAdmissionsStatement(database, runId, gamesJson, canonicalJson(await sourceAuthorities(database))).run();
  } catch (error) {
    const winner = await admissionPinStatement(database, runId).first<{ games_json: string }>();
    if (winner?.games_json !== gamesJson) throw error;
  }
}
export type AdmittedEntity = {
  card: CatalogueCard;
  printing: CataloguePrinting | null;
  linked: boolean;
  warnings: Record<string, unknown>[];
};
export async function applyPinnedEntityAdmissions(
  database: CatalogueStore,
  runId: string,
  cards: Map<string, CatalogueCard>,
  printings: Map<string, CataloguePrinting>,
  warnings: Record<string, unknown>[],
) {
  let after = "";
  const admitted: AdmittedEntity[] = [];
  while (true) {
    const rows = (
      await pinnedAdmissionsStatement(database, runId, after).all<
        EntityProposalRow & {
          decision_json: string | null;
          action: string | null;
          generation: number;
        }
      >()
    ).results;
    for (const row of rows) {
      if (row.action !== "admit" && row.action !== "link") {
        warnings.push({
          code: "entity_proposal_excluded",
          proposal_id: row.id,
          generation: row.generation,
          detail: `Entity Proposal ${row.id} is ${row.action === "reject" ? "owner-rejected" : "unresolved"} and excluded from this candidate.`,
        });
        continue;
      }
      const decision = JSON.parse(row.decision_json!) as AdmittedEntity & { policy_digest?: string };
      if (decision.policy_digest !== (await admissionPolicyDigest(row.source_lineage, decision.card.game_data.profile)))
        warnings.push({
          code: "entity_admission_reassessment_required",
          proposal_id: row.id,
          generation: row.generation,
          detail: `Entity Proposal ${row.id} was admitted under changed requirements. Reassess the accepted identity; policy change alone does not remove it.`,
        });
      if (!decision.linked) {
        if (!cards.has(decision.card.id)) cards.set(decision.card.id, decision.card);
        if (decision.printing && !printings.has(decision.printing.id))
          printings.set(decision.printing.id, decision.printing);
      }
      admitted.push(decision);
      warnings.push(
        {
          code: "entity_admission",
          proposal_id: row.id,
          generation: row.generation,
          card_id: decision.card.id,
          printing_id: decision.printing?.id ?? null,
          detail: `Entity Proposal ${row.id} admitted by immutable decision ${row.generation}; candidate approval is still required.`,
        },
        ...decision.warnings,
      );
    }
    if (rows.length < 100) return admitted;
    after = rows.at(-1)!.id;
  }
}
