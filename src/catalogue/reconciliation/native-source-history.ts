import { type CatalogueStore, canonicalJson } from "../shared";
import {
  legacySourceHistoryStatement,
  type SourceHistoryCandidate,
  sourceHistoryCandidateStatement,
} from "./native-source-history-repository";
import {
  NativeSourceHistory,
  type SourceHistoryPosition,
  type SourceHistoryRecord,
} from "./native-source-history-state";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { type ObservationPlan, ReconciliationPlanState } from "./reconciliation-plan-state";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { membershipEntries } from "./reconciliation-relationships";

type Coverage = {
  sourceLineage: string;
  supportedGame: string;
  subset?: string;
  reconciliationCapability?: string;
  cardIdentities?: { kind: string; value: string | null }[];
};
type Frame = { id: string; preparation: string; game: string; plans: number; coverage: Coverage[] };
type Stage = "walk" | "copy" | "legacy" | "frame" | "missing" | "observations" | "prior_ready" | "complete";
export type SourceHistoryCursor = {
  version: 1;
  stage: Stage;
  current: string;
  next: string | null;
  boundary: string;
  depth: number;
  walkPosition: number;
  visitedPosition: number;
  history: SourceHistoryPosition;
  prior?: SourceHistoryPosition;
  copy?: { preparation: string; history: SourceHistoryPosition };
  frame?: Frame;
  after: string;
  scanned: number;
  through: SourceHistoryPosition;
  planPart: number;
  legacyKind: "card" | "locator" | "membership";
  legacyAfter: number;
  finishing: boolean;
};
type SharedCheckpoint = Record<string, unknown> & { sourceHistory?: SourceHistoryCursor };

/** Rebuild only through captured predecessors; every traversal, scan and retained effect has a durable cursor. */
export async function prepareNativeSourceHistory(
  db: CatalogueStore,
  preparation: string,
  finishCurrent: boolean,
  yieldAtCheckpoint: boolean,
) {
  const current = await sourceHistoryCandidateStatement(db, preparation).first<SourceHistoryCandidate>();
  if (!current) return null;
  requireCandidate(current, current.supported_game, false);
  let checkpoint = await reconciliationCheckpoint<SharedCheckpoint>(db, preparation, "disappearance_warnings");
  const empty = { position: 0, count: 0, entities: 0 };
  const cursor: SourceHistoryCursor = checkpoint?.value.sourceHistory ?? {
    version: 1,
    stage: "walk",
    current: current.id,
    next: current.predecessor_candidate_id,
    boundary: current.expected_game_revision_id,
    depth: 0,
    walkPosition: 0,
    visitedPosition: 0,
    history: empty,
    after: "",
    scanned: 0,
    through: empty,
    planPart: 0,
    legacyKind: "card",
    legacyAfter: 0,
    finishing: false,
  };
  if (cursor.version !== 1 || cursor.current !== current.id)
    throw new Error("Native source history continuation changed its candidate.");
  const history = new NativeSourceHistory(db, preparation, cursor.history);
  const walk = new ReconciliationReducerIndex<Frame>(db, preparation, "source_history_walk");
  const visited = new ReconciliationReducerIndex<boolean>(db, preparation, "source_history_visited");
  walk.resumeAt(cursor.walkPosition);
  visited.resumeAt(cursor.visitedPosition);
  const save = async () => {
    cursor.history = history.cursor;
    cursor.walkPosition = walk.position;
    cursor.visitedPosition = visited.position;
    const ordinal = (checkpoint?.ordinal ?? -1) + 1;
    const value = { ...checkpoint?.value, sourceHistory: cursor };
    await retainReconciliationCheckpoint(db, preparation, "disappearance_warnings", ordinal, value);
    checkpoint = { ordinal, value };
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "disappearance_warnings", ordinal });
  };
  let work = 0;
  while (cursor.stage !== "complete") {
    if (cursor.stage === "prior_ready") {
      if (!finishCurrent) break;
      cursor.finishing = true;
      cursor.frame = await requiredFrame(db, current);
      cursor.stage = "missing";
      cursor.through = history.cursor;
      cursor.after = "";
      cursor.scanned = 0;
    } else if (cursor.stage === "walk") {
      if (cursor.next === null) cursor.stage = "legacy";
      else {
        if (cursor.next === current.id || (await visited.has(cursor.next)))
          throw new Error("Native source history predecessor chain contains a cycle.");
        const candidate = await sourceHistoryCandidateStatement(db, cursor.next).first<SourceHistoryCandidate>();
        requireCandidate(candidate, current.supported_game, true);
        if (candidate.game_revision_id !== cursor.boundary)
          throw new Error("Native source history predecessor differs from its pinned game revision.");
        await visited.seed(candidate.id, true);
        const retained = await reconciliationCheckpoint<SharedCheckpoint>(
          db,
          candidate.preparation_id,
          "disappearance_warnings",
        );
        const previous = retained?.value.sourceHistory;
        if (previous) {
          if (previous.version !== 1 || previous.stage !== "complete" || previous.current !== candidate.id)
            throw new Error("Published native source history is incomplete.");
          cursor.copy = { preparation: candidate.preparation_id, history: previous.history };
          cursor.stage = "copy";
        } else {
          await walk.seed(String(++cursor.depth), await requiredFrame(db, candidate));
          cursor.next = candidate.predecessor_candidate_id;
          cursor.boundary = candidate.expected_game_revision_id;
        }
      }
    } else if (cursor.stage === "copy") {
      if (!cursor.copy) throw new Error("Native source history copy lost its predecessor.");
      const prior = new NativeSourceHistory(db, cursor.copy.preparation, cursor.copy.history);
      const next = await prior.entries(cursor.after).next();
      if (next.done) {
        if (cursor.scanned !== cursor.copy.history.count)
          throw new Error("Native source history predecessor prefix is missing records.");
        cursor.stage = "frame";
        cursor.after = "";
        cursor.scanned = 0;
      } else {
        await history.retain(next.value.value);
        cursor.after = next.value.key;
        cursor.scanned++;
      }
    } else if (cursor.stage === "legacy") {
      const row = await legacySourceHistoryStatement(
        db,
        current.supported_game,
        cursor.legacyKind,
        cursor.legacyAfter,
      ).first<LegacyHistoryRow>();
      if (row) {
        const record = legacyHistoryRecord(cursor.legacyKind, row);
        // Several retained Card observations can prove one current source authority.
        const prior = await history.index.get(record.id);
        if (record.kind === "card" && prior?.current && !record.current) record.current = true;
        await history.retain(record);
        cursor.legacyAfter = row.history_rowid;
      } else {
        cursor.legacyAfter = 0;
        if (cursor.legacyKind === "card") cursor.legacyKind = "locator";
        else if (cursor.legacyKind === "locator") cursor.legacyKind = "membership";
        else cursor.stage = "frame";
      }
    } else if (cursor.stage === "frame") {
      if (cursor.depth === 0) {
        cursor.prior = history.cursor;
        cursor.stage = "prior_ready";
      } else {
        const frame = await walk.get(String(cursor.depth--));
        if (!frame) throw new Error("Native source history reconstruction lost a retained frame.");
        cursor.frame = frame;
        cursor.stage = "missing";
        cursor.through = history.cursor;
        cursor.after = "";
        cursor.scanned = 0;
      }
    } else if (cursor.stage === "missing") {
      const frame = requiredCursorFrame(cursor);
      const before = new NativeSourceHistory(db, preparation, cursor.through);
      const next = await before.entries(cursor.after).next();
      if (next.done) {
        if (cursor.scanned !== cursor.through.count)
          throw new Error("Native source history prefix is missing records during disappearance.");
        cursor.stage = "observations";
        cursor.after = "";
        cursor.planPart = 0;
        cursor.scanned = 0;
      } else {
        const record = next.value.value;
        if (record.current && (await checkedHistory(db, frame, record)))
          await history.retain({ ...record, current: false, missing: { candidate: frame.id } });
        cursor.after = next.value.key;
        cursor.scanned++;
      }
    } else if (cursor.stage === "observations") {
      const frame = requiredCursorFrame(cursor);
      const plans = new ReconciliationPlanState(db, frame.preparation);
      plans.resumeAt(frame.plans);
      const next = await plans.values(cursor.after).next();
      if (next.done) {
        if (cursor.scanned !== frame.plans)
          throw new Error("Native source history observation prefix is missing records.");
        cursor.stage = cursor.finishing ? "complete" : "frame";
        cursor.after = "";
      } else {
        const plan = next.value;
        const events = historyObservation(frame, plan);
        if (cursor.planPart < events.length) {
          const event = events[cursor.planPart++]!;
          await history.retain(event, { preserveFirst: true });
        }
        if (cursor.planPart === events.length) {
          cursor.after = plan.sourceObservationId;
          cursor.planPart = 0;
          cursor.scanned++;
        }
      }
    }
    // Eight bounded records per durable unit avoid a new Workflow dispatch for every small history row.
    if (++work === 8 || cursor.stage === "prior_ready" || cursor.stage === "complete") {
      await save();
      work = 0;
    }
  }
  if (!cursor.prior) throw new Error("Native source history has no completed predecessor prefix.");
  return { prior: new NativeSourceHistory(db, preparation, cursor.prior), current: history };
}

function requireCandidate(
  candidate: SourceHistoryCandidate | null,
  game: string,
  published: boolean,
): asserts candidate is SourceHistoryCandidate {
  if (
    !candidate ||
    candidate.supported_game !== game ||
    candidate.id !== candidate.preparation_id ||
    candidate.pin_id !== candidate.id ||
    (published && candidate.catalogue_revision_id === null)
  )
    throw new Error("Native source history is missing its exact published predecessor or immutable pin.");
}
async function requiredFrame(db: CatalogueStore, candidate: SourceHistoryCandidate): Promise<Frame> {
  const reduction = await reconciliationCheckpoint<{
    complete: boolean;
    indexes: { plans: number };
    input: { evidencePlans: Coverage[] };
  }>(db, candidate.preparation_id, "official_reduction");
  const frame = reduction?.value;
  if (
    !frame?.complete ||
    !Number.isSafeInteger(frame.indexes.plans) ||
    frame.indexes.plans < 0 ||
    !Array.isArray(frame.input.evidencePlans) ||
    frame.input.evidencePlans.some(
      (plan) =>
        plan.supportedGame !== candidate.supported_game ||
        typeof plan.sourceLineage !== "string" ||
        (plan.subset !== undefined && (typeof plan.subset !== "string" || plan.subset.length === 0)),
    )
  )
    throw new Error("Native source history requires complete retained observation plans and declared coverage.");
  return {
    id: candidate.id,
    preparation: candidate.preparation_id,
    game: candidate.supported_game,
    plans: frame.indexes.plans,
    coverage: frame.input.evidencePlans,
  };
}
function requiredCursorFrame(cursor: SourceHistoryCursor) {
  if (!cursor.frame) throw new Error("Native source history lost its bounded observation frame.");
  return cursor.frame;
}
async function checkedHistory(db: CatalogueStore, frame: Frame, record: SourceHistoryRecord) {
  const coverage = frame.coverage.filter(
    (plan) => plan.sourceLineage === record.sourceLineage && plan.reconciliationCapability !== "errata",
  );
  if (!coverage.length) return false;
  if (
    coverage.some(
      (plan) =>
        (plan.subset ?? "complete") === "complete" ||
        plan.cardIdentities?.some(
          (identity) => identity.kind === record.identity.kind && identity.value === record.identity.value,
        ),
    )
  )
    return true;
  const plans = new ReconciliationPlanState(db, frame.preparation);
  plans.resumeAt(frame.plans);
  return plans.hasObserved(record.kind === "card" ? "card" : "printing", record.entityId, record.sourceLineage);
}
function historyObservation(frame: Frame, plan: ObservationPlan): SourceHistoryRecord[] {
  if (plan.supportedGame !== frame.game) throw new Error("Native source history observation changed its game.");
  if (plan.observationKind !== "card_printing") return [];
  if (!plan.sourceCardFactsJson) throw new Error("Native source history observation lacks retained Card facts.");
  const identity = JSON.parse(plan.sourceCardFactsJson).official_identity as SourceHistoryRecord["identity"];
  if (
    !identity ||
    typeof identity.kind !== "string" ||
    !(identity.value === null || typeof identity.value === "string")
  )
    throw new Error("Native source history observation lacks a valid Card identity.");
  const common = {
    cardId: plan.cardId,
    sourceLineage: plan.sourceLineage,
    identity,
    first: { candidate: frame.id },
    last: { candidate: frame.id },
    missing: null,
    current: true,
  };
  const events: SourceHistoryRecord[] = [
    { ...common, id: canonicalJson(["card", plan.cardId, plan.sourceLineage]), kind: "card", entityId: plan.cardId },
  ];
  if (plan.printingId !== null) {
    if (plan.locator === null) throw new Error("Native source history observation lacks its Printing locator.");
    events.push({
      ...common,
      id: canonicalJson(["locator", plan.printingId, plan.sourceLineage, plan.locator, plan.variantKey]),
      kind: "locator",
      entityId: plan.printingId,
      locator: plan.locator,
      variantKey: plan.variantKey,
    });
    for (const membership of membershipEntries(plan.memberships))
      events.push({
        ...common,
        id: canonicalJson([
          "membership",
          plan.printingId,
          plan.sourceLineage,
          membership.relationship_kind,
          membership.relationship_value,
          plan.sourceObservationId,
        ]),
        kind: "membership",
        entityId: plan.printingId,
        relationshipKind: membership.relationship_kind,
        relationshipValue: membership.relationship_value,
        sourceObservationId: plan.sourceObservationId,
      });
  }
  if (events.length > 500 || new TextEncoder().encode(canonicalJson(events)).byteLength > 1048576)
    throw new Error(
      "reconciliation_capacity_exceeded: one source history observation exceeds its bounded event allowance.",
    );
  return events;
}

type LegacyHistoryRow = {
  history_rowid: number;
  history_card_id: string;
  history_identity_kind: string;
  history_identity_value: string;
  printing_id?: string;
  source_lineage: string;
  source_observation_id?: string;
  catalogue_revision_id?: string;
  first_revision_id?: string;
  last_observed_revision_id?: string;
  current: number;
  last_missing_revision_id: string | null;
  locator?: string;
  variant_key?: string | null;
  relationship_kind?: SourceHistoryRecord["relationshipKind"];
  relationship_value?: string;
};
function legacyHistoryRecord(kind: "card" | "locator" | "membership", row: LegacyHistoryRow): SourceHistoryRecord {
  const entityId = kind === "card" ? row.history_card_id : row.printing_id!;
  const identity = {
    kind: row.history_identity_kind,
    value: row.history_identity_kind === "unknown" ? null : row.history_identity_value,
  };
  const binding =
    kind === "card"
      ? [kind, entityId, row.source_lineage]
      : kind === "locator"
        ? [kind, entityId, row.source_lineage, row.locator, row.variant_key]
        : [
            kind,
            entityId,
            row.source_lineage,
            row.relationship_kind,
            row.relationship_value,
            row.source_observation_id,
          ];
  return {
    id: canonicalJson(binding),
    kind,
    entityId,
    cardId: row.history_card_id,
    sourceLineage: row.source_lineage,
    identity,
    first: { revision: row.first_revision_id ?? row.catalogue_revision_id! },
    last: { revision: row.last_observed_revision_id ?? row.catalogue_revision_id! },
    missing: row.last_missing_revision_id === null ? null : { revision: row.last_missing_revision_id },
    current: row.current === 1,
    ...(kind === "locator" ? { locator: row.locator!, variantKey: row.variant_key ?? null } : {}),
    ...(kind === "membership"
      ? {
          relationshipKind: row.relationship_kind!,
          relationshipValue: row.relationship_value!,
          sourceObservationId: row.source_observation_id!,
        }
      : {}),
  };
}
