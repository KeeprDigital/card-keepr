import { type CatalogueStore, canonicalJson } from "../shared";
import type { CanonicalRecordSource } from "./reconciliation-canonical-digest";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";

type Cursor = {
  after: string;
  summary: Record<string, unknown>[];
  bytes: number;
  total: number;
  truncated: boolean;
  complete: boolean;
};

/** Count the full warning stream while retaining only the bounded owner summary. */
export async function prepareRunWarningSummary(
  database: CatalogueStore,
  runId: string,
  warnings: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
  yieldAtCheckpoint = false,
): Promise<Record<string, unknown>[]> {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "warning_summary");
  const cursor: Cursor = checkpoint?.value ?? {
    after: "",
    summary: [],
    bytes: 2,
    total: 0,
    truncated: false,
    complete: false,
  };
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let records = 0,
    bytes = 0;
  const save = async () => {
    await retainReconciliationCheckpoint(database, runId, "warning_summary", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "warning_summary", ordinal });
    ordinal++;
    records = bytes = 0;
  };
  if (!cursor.complete) {
    for await (const entry of entries(warnings, cursor.after)) {
      const value = publicRunDiagnostic(entry.value);
      const length = new TextEncoder().encode(canonicalJson(value)).byteLength;
      cursor.total++;
      if (!cursor.truncated) {
        if (cursor.summary.length === 100 || cursor.bytes + length > 65024) cursor.truncated = true;
        else {
          cursor.summary.push(value);
          cursor.bytes += length + 1;
        }
      }
      cursor.after = entry.key;
      bytes += length;
      if (++records === 4 || bytes >= 512000) await save();
    }
    cursor.complete = true;
    await save();
  }
  return cursor.truncated
    ? [
        ...cursor.summary,
        {
          code: "candidate_warnings_partitioned",
          detail: `Inspect the candidate warning partitions for all ${cursor.total} warnings.`,
        },
      ]
    : cursor.summary;
}

async function* entries(
  warnings: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
  after: string,
) {
  if (Array.isArray(warnings)) {
    for (let index = after ? Number(after) : 0; index < warnings.length; index++)
      yield { key: String(index + 1), value: warnings[index]! };
  } else {
    if (!("canonicalEntries" in warnings)) throw new Error("Warning summaries require a resumable record source.");
    yield* (warnings as CanonicalRecordSource<Record<string, unknown>>).canonicalEntries(after);
  }
}

function publicRunDiagnostic(diagnostic: Record<string, unknown>): Record<string, unknown> {
  const base = {
    code: String(diagnostic.code),
    detail: String(diagnostic.detail),
  };
  if (diagnostic.code !== "curated_revision_reconfirmation_required") {
    return base;
  }
  return {
    ...base,
    curated_revision_id: diagnostic.curated_revision_id,
    conflict_id: diagnostic.conflict_id,
    conflict_digest: diagnostic.conflict_digest,
  };
}
