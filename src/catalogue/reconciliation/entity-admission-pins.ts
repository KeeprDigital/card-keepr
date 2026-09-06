import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import type { ReconciliationRecordSink } from "./reconciliation-record-collection";
import { admissionPolicyDigest } from "./entity-admission-source";
import { sourceAuthorities } from "../source-evidence";
import {
  AdministrationProblem,
  type CatalogueStore,
  type CatalogueCard,
  type CataloguePrinting,
  canonicalJson,
  sha256Text,
} from "../shared";
import {
  admissionPinStatement,
  admissionPinMetadataPageStatement,
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
type AdmissionEntityIndex<T> = {
  has(id: string): boolean | Promise<boolean>;
  set(id: string, value: T): unknown;
  beginObservation?(): void;
};
export async function applyPinnedEntityAdmissions(
  database: CatalogueStore,
  runId: string,
  cards: AdmissionEntityIndex<CatalogueCard>,
  printings: AdmissionEntityIndex<CataloguePrinting>,
  warnings: ReconciliationRecordSink<Record<string, unknown>>,
) {
  let after = "";
  const admittedCards = new ReconciliationReducerIndex<boolean>(database, runId, "admitted_card_ids");
  const admittedPrintings = new ReconciliationReducerIndex<boolean>(database, runId, "admitted_printing_ids");
  let cardCount = 0,
    printingCount = 0;
  const admitted = {
    hasCard: (id: string) => (cardCount === 0 ? false : admittedCards.has(id)),
    hasPrinting: (id: string) => (printingCount === 0 ? false : admittedPrintings.has(id)),
  };
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
      cards.beginObservation?.();
      printings.beginObservation?.();
      if (row.action !== "admit" && row.action !== "link") {
        await warnings.push({
          code: "entity_proposal_excluded",
          proposal_id: row.id,
          generation: row.generation,
          detail: `Entity Proposal ${row.id} is ${row.action === "reject" ? "owner-rejected" : "unresolved"} and excluded from this candidate.`,
        });
        continue;
      }
      const decision = JSON.parse(row.decision_json!) as AdmittedEntity & { policy_digest?: string };
      if (decision.policy_digest !== (await admissionPolicyDigest(row.source_lineage, decision.card.game_data.profile)))
        await warnings.push({
          code: "entity_admission_reassessment_required",
          proposal_id: row.id,
          generation: row.generation,
          detail: `Entity Proposal ${row.id} was admitted under changed requirements. Reassess the accepted identity; policy change alone does not remove it.`,
        });
      if (!decision.linked) {
        if (!(await cards.has(decision.card.id))) await cards.set(decision.card.id, decision.card);
        if (decision.printing && !(await printings.has(decision.printing.id)))
          await printings.set(decision.printing.id, decision.printing);
      }
      await admittedCards.seed(decision.card.id, true);
      cardCount++;
      if (decision.printing) {
        await admittedPrintings.seed(decision.printing.id, true);
        printingCount++;
      }
      await warnings.push(
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
    if (rows.length === 0) return admitted;
    after = rows.at(-1)!.id;
  }
}

/** Compose this with operation creation; retries reuse the retained selection. */
export async function entityAdmissionPinStatementsForNewRun(
  database: CatalogueStore,
  runId: string,
  games: readonly string[],
) {
  const gamesJson = canonicalJson([...new Set(games)].sort());
  const existing = await admissionPinStatement(database, runId).first<{ games_json: string }>();
  if (existing) {
    if (existing.games_json !== gamesJson)
      throw new AdministrationProblem(
        409,
        "admission_pin_conflict",
        "The run's admission game selection is immutable.",
      );
    return [];
  }
  return [pinAdmissionsStatement(database, runId, gamesJson, canonicalJson(await sourceAuthorities(database)))];
}

export async function entityAdmissionPinMetadata(database: CatalogueStore, runId: string) {
  const pin = await admissionPinStatement(database, runId).first<{ games_json: string; policy_json: string }>();
  if (!pin) throw new Error("Reconciliation admission pins are unavailable.");
  let digest = await sha256Text(canonicalJson({ games: pin.games_json, policy: pin.policy_json }));
  let after = "";
  let count = 0;
  for (;;) {
    const page = (
      await admissionPinMetadataPageStatement(database, runId, after).all<{ proposal_id: string; generation: number }>()
    ).results;
    for (const row of page) {
      digest = await sha256Text(canonicalJson({ previous: digest, ...row }));
      after = row.proposal_id;
      count++;
    }
    if (page.length < 100) return { sha256: digest, decision_count: count };
  }
}
