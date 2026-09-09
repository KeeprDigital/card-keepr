import { catalogueStore } from "../../../../src/catalogue/shared";
import { reconciliationCheckpoint } from "../../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { ReconciliationReducerIndex } from "../../../../src/catalogue/reconciliation/reconciliation-reducer-state";

/** Preserve rich private diagnostic oracles without changing the compact native terminal response. */
export async function nativeDiagnosticRecords(database: D1Database, preparationId: string) {
  const store = catalogueStore(database);
  const checkpoint = await reconciliationCheckpoint<{
    complete: boolean;
    diagnostics: { position: number; count: number };
  }>(store, preparationId, "official_reduction");
  if (!checkpoint?.value.complete) throw new Error("Native diagnostics have no completed official reduction.");
  const rows = new ReconciliationReducerIndex<{ id: string; value: Record<string, unknown> }>(
    store,
    preparationId,
    "diagnostic_records",
  );
  rows.resumeAt(checkpoint.value.diagnostics.position);
  const diagnostics: Record<string, unknown>[] = [];
  let bytes = 0;
  for await (const entry of rows.insertionEntries()) {
    bytes += new TextEncoder().encode(JSON.stringify(entry.value.value)).byteLength;
    if (diagnostics.length === 500 || bytes > 524288) throw new Error("Diagnostic fixture exceeds its bound.");
    diagnostics.push(entry.value.value);
  }
  if (diagnostics.length !== checkpoint.value.diagnostics.count) throw new Error("Native diagnostic prefix changed.");
  return diagnostics;
}
