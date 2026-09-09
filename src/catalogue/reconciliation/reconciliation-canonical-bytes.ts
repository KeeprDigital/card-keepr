import { type CatalogueStore, sha256Text } from "../shared";
import { documentStorage } from "./reconciliation-document";
import { canonicalBytesStatement, retainCanonicalBytesStatement } from "./reconciliation-canonical-bytes-repository";

type Row = { content: string; sha256: string };

/** Exact canonical bytes are reusable after their hash cursor commits. */
export async function retainCanonicalBytes(database: CatalogueStore, runId: string, ordinal: number, content: string) {
  if (new TextEncoder().encode(content).byteLength > 524288)
    throw new Error("reconciliation_capacity_exceeded: canonical bytes exceed one chunk.");
  const sha256 = await sha256Text(content);
  const inserted = await documentStorage(() =>
    retainCanonicalBytesStatement(database, runId, ordinal, content, sha256).first<Row>(),
  );
  const retained =
    inserted ?? (await documentStorage(() => canonicalBytesStatement(database, runId, ordinal).first<Row>()));
  if (retained?.content !== content || retained.sha256 !== sha256)
    throw new Error("Canonical byte replay changed immutable content.");
}

export async function readCanonicalBytes(database: CatalogueStore, runId: string, ordinal: number) {
  const row = await documentStorage(() => canonicalBytesStatement(database, runId, ordinal).first<Row>());
  if (!row || (await sha256Text(row.content)) !== row.sha256)
    throw new Error("Retained canonical bytes failed integrity verification.");
  return row.content;
}
