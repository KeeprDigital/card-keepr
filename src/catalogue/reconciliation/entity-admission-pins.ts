import { documentStorage } from "./reconciliation-document";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
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
  admissionSelectionPageStatement,
  retainAdmissionSelectionStatement,
  admissionSelectionReceiptStatement,
  admissionPinMetadataPageStatement,
  pinAdmissionsStatement,
  pinnedAdmissionsStatement,
  type EntityProposalRow,
} from "./entity-admission-repository";

export async function pinEntityAdmissions(
  database: CatalogueStore,
  runId: string,
  games: readonly string[],
  yieldAtCheckpoint = false,
) {
  const gamesJson = canonicalJson([...new Set(games)].sort());
  let existing = await admissionPinStatement(database, runId).first<{
    games_json: string;
    decision_cutoff: number | null;
  }>();
  if (!existing) {
    try {
      await pinAdmissionsStatement(database, runId, gamesJson, canonicalJson(await sourceAuthorities(database))).run();
    } catch (error) {
      const winner = await admissionPinStatement(database, runId).first<{ games_json: string }>();
      if (winner?.games_json !== gamesJson) throw error;
    }
    existing = await admissionPinStatement(database, runId).first<{
      games_json: string;
      decision_cutoff: number | null;
    }>();
  }
  if (!existing || existing.games_json !== gamesJson)
    throw new AdministrationProblem(409, "admission_pin_conflict", "The run's admission game selection is immutable.");
  if (existing.decision_cutoff === null) return;
  type Cursor = { after: number; decisions: number; complete: boolean };
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "admission_selection");
  const cursor = checkpoint?.value ?? { after: 0, decisions: 0, complete: false };
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  while (!cursor.complete) {
    const rows = (
      await documentStorage(() =>
        admissionSelectionPageStatement(database, runId, cursor.after).all<{
          sequence: number;
          proposal_id: string;
          generation: number | null;
        }>(),
      )
    ).results;
    const selected = rows
      .flatMap((row) => (row.generation === null ? [] : [{ proposal_id: row.proposal_id, generation: row.generation }]))
      .sort((left, right) => left.proposal_id.localeCompare(right.proposal_id));
    if (selected.length) {
      await documentStorage(() =>
        database.batch(
          selected.map((row) => retainAdmissionSelectionStatement(database, runId, row.proposal_id, row.generation)),
        ),
      );
      const receipt = (
        await documentStorage(() =>
          admissionSelectionReceiptStatement(
            database,
            runId,
            selected.map((row) => row.proposal_id),
          ).all<{ proposal_id: string; generation: number }>(),
        )
      ).results;
      if (canonicalJson(receipt) !== canonicalJson(selected))
        throw new Error("Admission selection replay changed immutable decisions.");
      cursor.decisions += selected.length;
    }
    if (rows.length) cursor.after = rows[rows.length - 1]!.sequence;
    cursor.complete = rows.length < 50;
    await retainReconciliationCheckpoint(database, runId, "admission_selection", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "admission_selection", ordinal });
    ordinal++;
  }
}
export type AdmittedEntity = {
  card: CatalogueCard;
  printing: CataloguePrinting | null;
  linked: boolean;
  warnings: Record<string, unknown>[];
};
type AdmissionEntityIndex<T> = {
  readonly position: number;
  resumeAt(position: number): void;
  has(id: string): boolean | Promise<boolean>;
  set(id: string, value: T): unknown;
  beginObservation?(): void;
};
type AdmissionCursor = {
  after: string;
  cards: number;
  printings: number;
  cardPosition: number;
  printingPosition: number;
  warnings: { position: number; count: number };
  processedDecisions: number;
  pendingWarning: number | null;
  complete: boolean;
};
export async function applyPinnedEntityAdmissions(
  database: CatalogueStore,
  runId: string,
  cards: AdmissionEntityIndex<CatalogueCard>,
  printings: AdmissionEntityIndex<CataloguePrinting>,
  warnings: ReconciliationRecordSink<Record<string, unknown>> & {
    readonly cursor: { position: number; count: number };
    resumeAt(cursor: { position: number; count: number }): void;
  },
  options: { cursor?: { cards: number; printings: number }; yieldAtCheckpoint: boolean },
) {
  let after = "";
  const admittedCards = new ReconciliationReducerIndex<boolean>(database, runId, "admitted_card_ids");
  const admittedPrintings = new ReconciliationReducerIndex<boolean>(database, runId, "admitted_printing_ids");
  let cardCount = 0,
    printingCount = 0;
  const admitted = {
    get cursor() {
      return { cards: cardCount, printings: printingCount };
    },
    hasCard: (id: string) => (cardCount === 0 ? false : admittedCards.has(id)),
    hasPrinting: (id: string) => (printingCount === 0 ? false : admittedPrintings.has(id)),
  };
  if (options.cursor) {
    admittedCards.resumeAt(options.cursor.cards);
    admittedPrintings.resumeAt(options.cursor.printings);
    cardCount = options.cursor.cards;
    printingCount = options.cursor.printings;
    return admitted;
  }
  const checkpoint = await reconciliationCheckpoint<AdmissionCursor>(database, runId, "entity_admissions");
  let processedDecisions = checkpoint?.value.processedDecisions ?? 0;
  let pendingWarning = checkpoint?.value.pendingWarning ?? null;
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  if (checkpoint) {
    after = checkpoint.value.after;
    cardCount = checkpoint.value.cards;
    printingCount = checkpoint.value.printings;
    admittedCards.resumeAt(cardCount);
    admittedPrintings.resumeAt(printingCount);
    cards.resumeAt(checkpoint.value.cardPosition);
    printings.resumeAt(checkpoint.value.printingPosition);
    warnings.resumeAt(checkpoint.value.warnings);
    if (checkpoint.value.complete) return admitted;
  }
  const save = async (complete: boolean) => {
    await retainReconciliationCheckpoint(database, runId, "entity_admissions", ordinal, {
      after,
      cards: cardCount,
      printings: printingCount,
      cardPosition: cards.position,
      printingPosition: printings.position,
      warnings: warnings.cursor,
      processedDecisions,
      pendingWarning,
      complete,
    } satisfies AdmissionCursor);
    if (options.yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "entity_admissions", ordinal });
    ordinal++;
  };
  let records = 0,
    bytes = 0;
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
      const size = new TextEncoder().encode(canonicalJson(row)).byteLength;
      if (records > 0 && (records >= 4 || bytes + size > 512000)) {
        await save(false);
        records = 0;
        bytes = 0;
      }
      admission: {
        if (pendingWarning !== null) break admission;
        cards.beginObservation?.();
        printings.beginObservation?.();
        if (row.action !== "admit" && row.action !== "link") {
          await warnings.push({
            code: "entity_proposal_excluded",
            proposal_id: row.id,
            generation: row.generation,
            detail: `Entity Proposal ${row.id} is ${row.action === "reject" ? "owner-rejected" : "unresolved"} and excluded from this candidate.`,
          });
          break admission;
        }
        const decision = JSON.parse(row.decision_json!) as AdmittedEntity & { policy_digest?: string };
        if (
          decision.policy_digest !== (await admissionPolicyDigest(row.source_lineage, decision.card.game_data.profile))
        )
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
        await warnings.push({
          code: "entity_admission",
          proposal_id: row.id,
          generation: row.generation,
          card_id: decision.card.id,
          printing_id: decision.printing?.id ?? null,
          detail: `Entity Proposal ${row.id} admitted by immutable decision ${row.generation}; candidate approval is still required.`,
        });
        pendingWarning = 0;
      }
      if (pendingWarning !== null) {
        const decision = JSON.parse(row.decision_json!) as AdmittedEntity;
        while (pendingWarning < decision.warnings.length) {
          const warning = decision.warnings[pendingWarning]!;
          const length = new TextEncoder().encode(canonicalJson(warning)).byteLength;
          if (records > 0 && (records >= 4 || bytes + length > 512000)) {
            await save(false);
            records = bytes = 0;
          }
          await warnings.push(warning);
          pendingWarning++;
          records++;
          bytes += length;
        }
        pendingWarning = null;
      }
      after = row.id;
      processedDecisions++;
      records++;
      bytes += size;
    }
    if (rows.length === 0) {
      await save(true);
      return admitted;
    }
  }
}

/** Compose this with operation creation; retries reuse the retained selection. */
export async function entityAdmissionPinStatementsForPreparation(
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
