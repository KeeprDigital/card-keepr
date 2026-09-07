import type { CatalogueStore } from "../shared";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { type ReconciliationInputRecordCursor, verifiedReconciliationRecordEntries } from "./reconciliation-input";
import type { ReconciliationRecordSink } from "./reconciliation-record-collection";

type Cursor = {
  kindIndex: number;
  after: ReconciliationInputRecordCursor | null;
  warnings: { position: number; count: number };
  processedWarnings: number;
  complete: boolean;
};

/** Seed source-check and missing-image warnings from the frozen input, in returning groups. */
export async function prepareInitialWarnings(
  database: CatalogueStore,
  runId: string,
  warnings: ReconciliationRecordSink<Record<string, unknown>> & {
    readonly cursor: { position: number; count: number };
    resumeAt(cursor: { position: number; count: number }): void;
  },
  yieldAtCheckpoint: boolean,
) {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "initial_warnings");
  let kindIndex = checkpoint?.value.kindIndex ?? 0;
  let after = checkpoint?.value.after ?? null;
  let processedWarnings = checkpoint?.value.processedWarnings ?? 0;
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  if (checkpoint) {
    warnings.resumeAt(checkpoint.value.warnings);
    if (checkpoint.value.complete) return;
  }
  const save = async (complete: boolean) => {
    await retainReconciliationCheckpoint(database, runId, "initial_warnings", ordinal, {
      kindIndex,
      after,
      processedWarnings,
      warnings: warnings.cursor,
      complete,
    } satisfies Cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "initial_warnings", ordinal });
    ordinal++;
  };
  let records = 0,
    bytes = 0;
  const kinds = ["countChangeWarnings", "unavailablePrintingImages"] as const;
  for (; kindIndex < kinds.length; kindIndex++) {
    for await (const entry of verifiedReconciliationRecordEntries<Record<string, unknown>>(
      database,
      runId,
      kinds[kindIndex]!,
      after,
    )) {
      if (records > 0 && (records === 8 || bytes + entry.byteLength > 512000)) {
        await save(false);
        records = 0;
        bytes = 0;
      }
      const value = entry.value;
      await warnings.push(
        kindIndex === 0
          ? value
          : {
              code: "printing_image_unavailable",
              request_id: value.requestId,
              source_url: value.sourceUrl,
              source_lineage: value.sourceLineage,
              failure_code: value.failureCode,
              detail:
                "The Official Source did not serve this Printing Image within its bounded transport retries; the Printing is published without it and a later run can collect it.",
            },
      );
      processedWarnings++;
      records++;
      bytes += entry.byteLength;
      after = entry.cursor;
    }
    after = null;
  }
  await save(true);
}
