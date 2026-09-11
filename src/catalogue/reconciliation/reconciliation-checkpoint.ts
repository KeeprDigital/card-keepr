import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { documentStorage } from "./reconciliation-document";
import {
  exactReconciliationCheckpointStatement,
  latestReconciliationCheckpointStatement,
  retainReconciliationCheckpointStatement,
  reconciliationCheckpointWindowStatement,
} from "./reconciliation-checkpoint-repository";

type CheckpointRow = { ordinal: number; content: string; sha256: string };
const readWindow = Symbol("reconciliation checkpoint read window");
type WindowStore = CatalogueStore & {
  [readWindow]?: { runId: string; rows: Map<string, CheckpointRow | null> };
};

/** A fresh guarded store owns this callback-local snapshot; writes refresh their exact phase. */
export async function prepareCheckpointReadWindow(database: CatalogueStore, runId: string, phases: readonly string[]) {
  if (phases.length > 16 || new Set(phases).size !== phases.length)
    throw new Error("Invalid reconciliation checkpoint read window.");
  const rows = new Map<string, CheckpointRow | null>();
  let remaining = [...phases].sort();
  while (remaining.length) {
    const page = await documentStorage(() =>
      reconciliationCheckpointWindowStatement(database, runId, remaining).all<CheckpointRow & { phase: string }>(),
    );
    if (!page.success || !page.results.length || page.results.some((row, index) => row.phase !== remaining[index]))
      throw new Error("Reconciliation checkpoint read window returned an incomplete page.");
    for (const row of page.results) rows.set(row.phase, row.content === null ? null : row);
    remaining = remaining.slice(page.results.length);
  }
  (database as WindowStore)[readWindow] = { runId, rows };
}
export async function reconciliationCheckpoint<T>(
  database: CatalogueStore,
  runId: string,
  phase: string,
): Promise<{ ordinal: number; value: T } | null> {
  const window = (database as WindowStore)[readWindow];
  const row =
    window?.runId === runId && window.rows.has(phase)
      ? (window.rows.get(phase) ?? null)
      : await documentStorage(() =>
          latestReconciliationCheckpointStatement(database, runId, phase).first<CheckpointRow>(),
        );
  if (!row) return null;
  if ((await sha256Text(row.content)) !== row.sha256)
    throw new Error("Reconciliation checkpoint failed integrity verification.");
  return { ordinal: row.ordinal, value: JSON.parse(row.content) as T };
}
export async function retainReconciliationCheckpoint(
  database: CatalogueStore,
  runId: string,
  phase: string,
  ordinal: number,
  value: unknown,
): Promise<void> {
  const content = canonicalJson(value);
  if (new TextEncoder().encode(content).byteLength > 65536)
    throw new Error("reconciliation_capacity_exceeded: one continuation checkpoint exceeds 64 KiB.");
  const digest = await sha256Text(content);
  const inserted = await documentStorage(() =>
    retainReconciliationCheckpointStatement(database, runId, phase, ordinal, content, digest).first<CheckpointRow>(),
  );
  const retained =
    inserted ??
    (await documentStorage(() =>
      exactReconciliationCheckpointStatement(database, runId, phase, ordinal).first<CheckpointRow>(),
    ));
  if (retained?.content !== content || retained.sha256 !== digest)
    throw new Error("Reconciliation checkpoint replay changed immutable content.");
  const window = (database as WindowStore)[readWindow];
  if (window?.runId === runId && window.rows.has(phase)) {
    const previous = window.rows.get(phase);
    if (!previous || ordinal >= previous.ordinal) window.rows.set(phase, retained);
  }
}
