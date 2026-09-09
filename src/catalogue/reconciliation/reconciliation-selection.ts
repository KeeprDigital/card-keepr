import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { documentStorage } from "./reconciliation-document";
import {
  retainEvidenceSelectionStatement,
  evidenceSelectionRequestStatement,
  nextEvidenceSelectionStatement,
} from "./reconciliation-selection-repository";

type SelectionRow = { content: string; sha256: string };
async function verifiedSelection<T>(row: SelectionRow): Promise<T> {
  if ((await sha256Text(row.content)) !== row.sha256)
    throw new Error("Retained evidence selection failed integrity verification.");
  return JSON.parse(row.content) as T;
}
export async function retainEvidenceSelection(
  database: CatalogueStore,
  runId: string,
  requestId: string,
  sequence: number,
  value: unknown,
) {
  const content = canonicalJson(value);
  if (new TextEncoder().encode(content).byteLength > 65536)
    throw new Error("reconciliation_capacity_exceeded: one request's evidence metadata exceeds 64 KiB.");
  const digest = await sha256Text(content);
  await documentStorage(() =>
    retainEvidenceSelectionStatement(database, runId, requestId, sequence, content, digest).run(),
  );
  const row = await documentStorage(() =>
    evidenceSelectionRequestStatement(database, runId, requestId).first<SelectionRow>(),
  );
  if (row?.content !== content || row.sha256 !== digest)
    throw new Error("Evidence selection replay changed immutable content.");
}
export async function retainedEvidenceSelectionRequest<T>(
  database: CatalogueStore,
  runId: string,
  requestId: string,
): Promise<T | undefined> {
  const row = await documentStorage(() =>
    evidenceSelectionRequestStatement(database, runId, requestId).first<SelectionRow>(),
  );
  return row ? verifiedSelection<T>(row) : undefined;
}
export async function* retainedEvidenceSelection<T>(
  database: CatalogueStore,
  runId: string,
  after?: { sequenceNumber: number; requestId: string; complete?: boolean },
): AsyncGenerator<T> {
  let sequence = after?.sequenceNumber ?? -1;
  let requestId = after?.requestId ?? "";
  let includeCurrent = after?.complete === false;
  for (;;) {
    const row = await documentStorage(() =>
      nextEvidenceSelectionStatement(database, runId, sequence, requestId, includeCurrent).first<
        SelectionRow & { request_id: string; sequence_number: number }
      >(),
    );
    if (!row) return;
    yield await verifiedSelection<T>(row);
    sequence = row.sequence_number;
    requestId = row.request_id;
    includeCurrent = false;
  }
}
