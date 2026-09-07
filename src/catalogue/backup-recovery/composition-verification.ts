import { canonicalJson, StreamingSha256 } from "../shared";
import {
  type CompositionVerificationQuery,
  compositionSnapshotTables,
  maximumPrivateSnapshotPageBytes,
} from "./composition-verification-repository";

export type CompositionSnapshotEvidence = {
  revision_id: string;
  composition_digest: string;
  publication_operation_id: string;
  ingestion_run_id: string;
  schema_migration_level: number;
  members: number;
  schema_sha256: string;
  tables: { table: string; rows: number; sha256: string }[];
};
export type CompositionQuery = (query: CompositionVerificationQuery) => Promise<Record<string, unknown>[]>;
export async function captureCompositionSnapshot(
  query: CompositionQuery,
  revisionId: string,
): Promise<CompositionSnapshotEvidence | null> {
  const [state] = await query({ kind: "composition-state", revisionId });
  if (!state?.publication_operation_id) return null;
  if (
    typeof state.content_digest !== "string" ||
    typeof state.ingestion_run_id !== "string" ||
    typeof state.publication_operation_id !== "string" ||
    typeof state.migration_level !== "number" ||
    typeof state.members !== "number" ||
    state.members < 1 ||
    state.members > 5 ||
    Number(state.cards) + Number(state.products) < 1 ||
    state.missing_search !== 0 ||
    state.missing_lifecycle !== 0 ||
    state.search_state !== "ready"
  )
    throw new Error("Composed catalogue invariants failed.");
  const schema = new StreamingSha256();
  let schemaAfter = "";
  for (;;) {
    const [entry] = await query({ kind: "composition-schema", after: schemaAfter });
    if (!entry) break;
    if (typeof entry.name !== "string" || entry.name <= schemaAfter) throw new Error("Invalid schema snapshot cursor.");
    schemaAfter = entry.name;
    schema.update(new TextEncoder().encode(canonicalJson(entry) + "\n"));
  }
  const tables: CompositionSnapshotEvidence["tables"] = [];
  for (const table of compositionSnapshotTables) {
    const digest = new StreamingSha256();
    let after = 0,
      rows = 0;
    for (;;) {
      const page = await query({ kind: "composition-page", table, after });
      if (page.length === 0) break;
      const privatePage = table === "reconciliation_checkpoints" || table === "reconciliation_reducer_state";
      if (page.length > (privatePage ? 4 : 1)) throw new Error("Snapshot page exceeds its row budget.");
      let pageBytes = 0;
      for (const row of page) {
        if (typeof row.snapshot_rowid !== "number" || row.snapshot_rowid <= after)
          throw new Error("Invalid snapshot cursor.");
        pageBytes += new TextEncoder().encode(canonicalJson(row)).byteLength;
        if (privatePage && pageBytes > maximumPrivateSnapshotPageBytes)
          throw new Error("Private snapshot page exceeds its byte budget.");
        after = row.snapshot_rowid;
        const { snapshot_rowid: _, ...record } = row;
        digest.update(new TextEncoder().encode(canonicalJson(record) + "\n"));
        rows++;
      }
    }
    tables.push({ table, rows, sha256: digest.digestHex() });
  }
  return {
    revision_id: revisionId,
    composition_digest: state.content_digest,
    publication_operation_id: state.publication_operation_id,
    ingestion_run_id: state.ingestion_run_id,
    schema_migration_level: state.migration_level,
    members: state.members,
    schema_sha256: schema.digestHex(),
    tables,
  };
}
export async function verifyCompositionSnapshot(query: CompositionQuery, expected: CompositionSnapshotEvidence) {
  if ((await query({ kind: "foreign-keys" })).length) throw new Error("Restored composition foreign keys failed.");
  const actual = await captureCompositionSnapshot(query, expected.revision_id);
  if (!actual || canonicalJson(actual) !== canonicalJson(expected))
    throw new Error("Restored composition snapshot differs.");
}
