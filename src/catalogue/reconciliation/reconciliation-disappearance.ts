import type { NativeSourceHistory } from "./native-source-history-state";
import type { SourceHistoryCursor } from "./native-source-history";
import { checkedPrintingLineages, type CheckedCardScope } from "./scoped-disappearance";
import type { CataloguePrinting } from "../shared";
import type { ReconciliationCardState } from "./reconciliation-card-state";
import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import type { ReconciliationErrataState } from "./reconciliation-errata-state";
import type { Memberships, PrintingCompatibility } from "./reconciliation-model";
import type { ReconciliationPlanState } from "./reconciliation-plan-state";
import { printingRelationshipsForLineageStatement } from "./reconciliation-read-repository";
import type { ReconciliationRecordSink } from "./reconciliation-record-collection";
import { ReconciliationReducerIndex, ReconciliationReducerStorageError } from "./reconciliation-reducer-state";
import { gundamAffectedPrintingIds, gundamPrintingLineages } from "./reconciliation-repository";
import { membershipEntries } from "./reconciliation-relationships";

type Group = {
  id: string;
  printingId: string;
  sourceLineage: string;
  memberships: Memberships;
  count: number;
  bytes: number;
};
type Stage =
  | "scoped_printings"
  | "scoped_cards"
  | "memberships"
  | "relationships"
  | "gundam_published"
  | "gundam_local"
  | "printings"
  | "cards"
  | "errata"
  | "complete";
type Cursor = {
  sourceHistory?: SourceHistoryCursor;
  stage: Stage;
  after: string;
  lineage: number;
  relationshipKind: string;
  relationshipValue: string;
  groups: number;
  scopedCards?: number;
  warnings: { position: number; count: number };
  processedRecords: number;
};

/** Present and absent records both advance a durable cursor; silent scans remain bounded. */
export async function prepareDisappearanceWarnings(
  database: CatalogueStore,
  runId: string,
  sources: {
    plans: ReconciliationPlanState;
    history?: NativeSourceHistory;
    cardScopes?: {
      scopes: readonly CheckedCardScope[];
      priorCards: ReconciliationCardState;
      priorPrintings: ReconciliationReducerIndex<CataloguePrinting>;
    };
    hasPrintings: boolean;
    checkedLineages: readonly string[];
    errataLineages: readonly string[];
    priorErrata: ReconciliationErrataState;
    observedErrata: ReconciliationErrataState;
    gundamProvenance: ReconciliationReducerIndex<("gundam-en-asia" | "gundam-en-us")[]>;
    printingCompatibility: ReconciliationReducerIndex<{ printingId: string; compatibility: PrintingCompatibility }>;
  },
  warnings: ReconciliationRecordSink<Record<string, unknown>> & {
    readonly cursor: { position: number; count: number };
    resumeAt(cursor: { position: number; count: number }): void;
  },
  yieldAtCheckpoint: boolean,
) {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "disappearance_warnings");
  const groups = new ReconciliationReducerIndex<Group>(database, runId, "disappearance_memberships");
  const scopedCards = new ReconciliationReducerIndex<{ id: string; lineage: string }>(
    database,
    runId,
    "scoped_prior_cards",
  );
  const firstUnscopedStage = sources.hasPrintings ? "memberships" : "relationships";
  let stage: Stage =
    checkpoint?.value.stage ?? (sources.cardScopes?.scopes.length ? "scoped_printings" : firstUnscopedStage);
  let after = checkpoint?.value.after ?? "";
  let lineage = checkpoint?.value.lineage ?? 0;
  let relationshipKind = checkpoint?.value.relationshipKind ?? "";
  let relationshipValue = checkpoint?.value.relationshipValue ?? "";
  let processedRecords = checkpoint?.value.processedRecords ?? 0;
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  if (checkpoint?.value.stage) {
    groups.resumeAt(checkpoint.value.groups);
    scopedCards.resumeAt(checkpoint.value.scopedCards ?? 0);
    warnings.resumeAt(checkpoint.value.warnings);
    if (stage === "complete") return;
  }
  const save = async () => {
    await retainReconciliationCheckpoint(database, runId, "disappearance_warnings", ordinal, {
      ...(checkpoint?.value.sourceHistory ? { sourceHistory: checkpoint.value.sourceHistory } : {}),
      stage,
      after,
      lineage,
      relationshipKind,
      relationshipValue,
      groups: groups.position,
      scopedCards: scopedCards.position,
      warnings: warnings.cursor,
      processedRecords,
    } satisfies Cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "disappearance_warnings", ordinal });
    ordinal++;
  };
  if (!checkpoint?.value.stage) await save();
  let records = 0,
    bytes = 0;
  const budget = async (value: unknown) => {
    const size = new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (records > 0 && (records === 8 || bytes + size > 512000)) {
      await save();
      records = 0;
      bytes = 0;
    }
    records++;
    bytes += size;
  };
  const finish = async (next: Stage) => {
    stage = next;
    after = "";
    lineage = 0;
    await save();
    records = 0;
    bytes = 0;
  };
  const warnScoped = async (kind: "card" | "printing", id: string, sourceLineage: string) => {
    if (!(await sources.plans.hasObserved(kind, id, sourceLineage)))
      await warnings.push({
        code: "record_not_observed",
        [`${kind}_id`]: id,
        source_lineage: sourceLineage,
        detail: `The ${kind === "card" ? "Card" : "Printing"} was not observed within the declared Card scope; it remains historical and is not withdrawn.`,
      });
  };
  if (stage === "scoped_printings") {
    if (!sources.cardScopes) throw new Error("Pinned Card scope is unavailable during disappearance resume.");
    const { scopes, priorCards, priorPrintings } = sources.cardScopes;
    for await (const printing of priorPrintings.entityValues(after)) {
      const card = await priorCards.get(printing.card_id);
      for (const sourceLineage of checkedPrintingLineages(card, printing, scopes)) {
        await scopedCards.seed(await sha256Text(canonicalJson([printing.card_id, sourceLineage])), {
          id: printing.card_id,
          lineage: sourceLineage,
        });
        await warnScoped("printing", printing.id, sourceLineage);
      }
      after = printing.id;
      processedRecords++;
      await save();
    }
    await finish("scoped_cards");
  }
  if (stage === "scoped_cards") {
    for await (const entry of scopedCards.latestEntries(after)) {
      await warnScoped("card", entry.value.id, entry.value.lineage);
      after = entry.key;
      processedRecords++;
      await save();
    }
    await finish(firstUnscopedStage);
  }
  if (stage === "memberships") {
    for await (const plan of sources.plans.values(after)) {
      await budget(plan);
      if (plan.observationKind === "card_printing" && plan.printingId !== null) {
        const id = await sha256Text(canonicalJson([plan.printingId, plan.sourceLineage]));
        const prior = await groups.get(id);
        const count = (prior?.count ?? 0) + 1;
        const bytes = (prior?.bytes ?? 0) + new TextEncoder().encode(canonicalJson(plan.memberships)).byteLength;
        if (count > 500 || bytes > 1048576)
          throw new Error("reconciliation_capacity_exceeded: one Printing lineage has too much membership evidence.");
        const merge = (kind: keyof Memberships) =>
          [...new Set([...(prior?.memberships[kind] ?? []), ...plan.memberships[kind]])].sort();
        await groups.seed(id, {
          id,
          printingId: plan.printingId,
          sourceLineage: plan.sourceLineage,
          count,
          bytes,
          memberships: {
            products: merge("products"),
            distribution_contexts: merge("distribution_contexts"),
            source_buckets: merge("source_buckets"),
          },
        });
      }
      after = plan.sourceObservationId;
    }
    await finish("relationships");
  }
  if (stage === "relationships") {
    for await (const group of groups.entityValues(after)) {
      const current = new Set(
        membershipEntries(group.memberships).map((row) =>
          canonicalJson([row.relationship_kind, row.relationship_value]),
        ),
      );
      const priorMemberships = sources.history
        ? (await sources.history.forEntity("printing", group.printingId))
            .filter(
              (record) =>
                record.kind === "membership" && record.current && record.sourceLineage === group.sourceLineage,
            )
            .map((record) => ({
              relationship_kind: record.relationshipKind!,
              relationship_value: record.relationshipValue!,
            }))
            .sort((a, b) =>
              a.relationship_kind < b.relationship_kind
                ? -1
                : a.relationship_kind > b.relationship_kind
                  ? 1
                  : a.relationship_value < b.relationship_value
                    ? -1
                    : a.relationship_value > b.relationship_value
                      ? 1
                      : 0,
            )
        : undefined;
      let firstInGroup = true;
      for (;;) {
        await budget(firstInGroup ? group : group.id);
        firstInGroup = false;
        let row: { relationship_kind: string; relationship_value: string } | null;
        try {
          row = priorMemberships
            ? (priorMemberships.find(
                (item) =>
                  item.relationship_kind > relationshipKind ||
                  (item.relationship_kind === relationshipKind && item.relationship_value > relationshipValue),
              ) ?? null)
            : await printingRelationshipsForLineageStatement(database, {
                printingId: group.printingId,
                sourceLineage: group.sourceLineage,
                afterKind: relationshipKind,
                afterValue: relationshipValue,
              }).first<typeof row>();
        } catch (cause) {
          throw new ReconciliationReducerStorageError(cause);
        }
        if (!row) break;
        if (!current.has(canonicalJson([row.relationship_kind, row.relationship_value])))
          await warnings.push({
            code: "relationship_not_observed",
            printing_id: group.printingId,
            relationship_kind: row.relationship_kind,
            relationship_value: row.relationship_value,
            detail:
              "The relationship was not observed in this complete run; it remains historical and is not withdrawn.",
          });
        relationshipKind = row.relationship_kind;
        relationshipValue = row.relationship_value;
      }
      after = group.id;
      relationshipKind = "";
      relationshipValue = "";
    }
    await finish("gundam_published");
  }
  const hasGundam = sources.checkedLineages.some(
    (lineage) => lineage === "gundam-en-asia" || lineage === "gundam-en-us",
  );
  const addGundamWarning = async (printingId: string) => {
    const lineages = new Set(
      (await gundamPrintingLineages(database, printingId, sources.history))
        .filter(({ source_lineage, current }) => current === 1 && !sources.checkedLineages.includes(source_lineage))
        .map(({ source_lineage }) => source_lineage),
    );
    for (const lineage of (await sources.gundamProvenance.get(printingId)) ?? []) lineages.add(lineage);
    if (lineages.size === 1)
      await warnings.push({
        code: "single_locale_gundam_printing",
        printing_id: printingId,
        source_lineage: [...lineages][0]!,
        detail:
          "The Gundam Printing is currently observed on only one English surface; publication retains that provenance for owner review.",
      });
  };
  if (stage === "gundam_published") {
    if (hasGundam)
      for await (const id of gundamAffectedPrintingIds(database, sources.checkedLineages, after)) {
        await budget(id);
        await addGundamWarning(id);
        after = id;
      }
    await finish("gundam_local");
  }
  if (stage === "gundam_local") {
    if (hasGundam)
      for await (const entry of sources.printingCompatibility.latestEntries(after)) {
        await budget(entry.value);
        const { printingId, compatibility } = entry.value;
        if (compatibility.source_lineage === "gundam-en-asia" || compatibility.source_lineage === "gundam-en-us") {
          const visited = (await gundamPrintingLineages(database, printingId, sources.history)).some(
            ({ source_lineage, current }) => current === 1 && sources.checkedLineages.includes(source_lineage),
          );
          if (!visited) await addGundamWarning(printingId);
        }
        after = entry.key;
      }
    await finish("printings");
  }
  for (const [expected, kind, next] of [
    ["printings", "printing", "cards"],
    ["cards", "card", "errata"],
  ] as const) {
    if (stage !== expected) continue;
    for (; lineage < sources.checkedLineages.length; lineage++) {
      for await (const entry of sources.plans.previousObservationEntries(
        kind,
        sources.checkedLineages[lineage]!,
        after,
      )) {
        await budget(entry);
        if (entry.warning) await warnings.push(entry.warning);
        after = entry.id;
        processedRecords++;
      }
      after = "";
    }
    await finish(next);
  }
  if (stage === "errata") {
    for (; lineage < sources.errataLineages.length; lineage++) {
      const sourceLineage = sources.errataLineages[lineage]!;
      for await (const erratum of sources.priorErrata.values(after)) {
        await budget(erratum);
        if (
          !(await sources.observedErrata.has(erratum.id)) &&
          erratum.provenance.some((item) => item.source_lineage === sourceLineage)
        )
          await warnings.push({
            code: "erratum_not_observed",
            erratum_id: erratum.id,
            source_lineage: sourceLineage,
            detail:
              "The previously published Erratum was not present in this complete Official Errata observation; it was retained without advancing its last-observed revision.",
          });
        after = erratum.id;
      }
      after = "";
    }
    await finish("complete");
  }
}
