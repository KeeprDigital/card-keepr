import { createHash } from "node:crypto";
import { canonicalJson } from "../shared";
import {
  type CompositionVerificationQuery,
  type AcceptedEvidenceArtifactRoot,
  compositionSnapshotTables,
  maximumSnapshotPageRows,
  maximumSnapshotPageBytes,
  maximumSchemaSnapshotPageRows,
  maximumSchemaSnapshotPageBytes,
} from "./composition-verification-repository";

export type CompositionSnapshotEvidence = {
  revision_id: string;
  composition_digest: string;
  publication_operation_id: string;
  ingestion_run_id: string;
  schema_migration_level: number;
  accepted_evidence_roots?: AcceptedEvidenceArtifactRoot[];
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
  let acceptedRoots: AcceptedEvidenceArtifactRoot[] | undefined;
  if (state.migration_level >= 31) {
    const rows = await query({ kind: "composition-accepted-roots" });
    if (
      rows.length !== state.members ||
      new Set(rows.map((row) => row.supported_game)).size !== rows.length ||
      rows.some(
        (row) =>
          ["supported_game", "candidate_id", "preparation_id"].some(
            (field) => typeof row[field] !== "string" || row[field] === "",
          ) ||
          !/^[a-f0-9]{64}$/.test(String(row.manifest_digest)) ||
          !/^[a-f0-9]{64}$/.test(String(row.root_digest)),
      )
    )
      throw new Error("Accepted private evidence roots are unavailable or invalid.");
    acceptedRoots = rows as AcceptedEvidenceArtifactRoot[];
  }
  const schema = createHash("sha256");
  let schemaAfter = "";
  for (;;) {
    const page = await query({ kind: "composition-schema", after: schemaAfter });
    if (page.length === 0) break;
    if (page.length > maximumSchemaSnapshotPageRows) throw new Error("Schema snapshot page exceeds its row budget.");
    let pageBytes = 0;
    for (const entry of page) {
      if (typeof entry.name !== "string" || entry.name <= schemaAfter)
        throw new Error("Invalid schema snapshot cursor.");
      const encoded = new TextEncoder().encode(canonicalJson(entry));
      pageBytes += encoded.byteLength;
      if (pageBytes > maximumSchemaSnapshotPageBytes) throw new Error("Schema snapshot page exceeds its byte budget.");
      schemaAfter = entry.name;
      schema.update(encoded);
      schema.update(new Uint8Array([10]));
    }
  }
  const tables: CompositionSnapshotEvidence["tables"] = [];
  for (const table of compositionSnapshotTables) {
    // Schema 30 snapshots predate accepted-evidence metadata and partition fingerprints.
    if (
      state.migration_level < 31 &&
      [
        "game_candidate_semantic_receipts",
        "game_candidate_predecessors",
        "game_accepted_candidates",
        "catalogue_acceptance_head",
        "game_candidate_partitions",
      ].includes(table)
    )
      continue;
    const columns = (await query({ kind: "composition-columns", table })).map((row) => {
      if (typeof row.name !== "string") throw new Error("Invalid composition snapshot columns.");
      return row.name;
    });
    const digest = createHash("sha256");
    let after = 0,
      rows = 0;
    for (;;) {
      const page = await query({ kind: "composition-page", table, after, columns });
      if (page.length === 0) break;
      const privatePage = table === "reconciliation_checkpoints" || table === "reconciliation_reducer_state";
      if (page.length > maximumSnapshotPageRows) throw new Error("Snapshot page exceeds its row budget.");
      let pageBytes = 0;
      for (const row of page) {
        if (typeof row.snapshot_rowid !== "number" || row.snapshot_rowid <= after)
          throw new Error("Invalid snapshot cursor.");
        pageBytes += new TextEncoder().encode(canonicalJson(row)).byteLength;
        if (pageBytes > maximumSnapshotPageBytes && (privatePage || page.length > 1))
          throw new Error("Private snapshot page exceeds its byte budget.");
        after = row.snapshot_rowid;
        const { snapshot_rowid: _, ...record } = row;
        digest.update(new TextEncoder().encode(canonicalJson(record) + "\n"));
        rows++;
      }
    }
    tables.push({ table, rows, sha256: digest.digest("hex") });
  }
  return {
    revision_id: revisionId,
    composition_digest: state.content_digest,
    publication_operation_id: state.publication_operation_id,
    ingestion_run_id: state.ingestion_run_id,
    schema_migration_level: state.migration_level,
    ...(acceptedRoots === undefined ? {} : { accepted_evidence_roots: acceptedRoots }),
    members: state.members,
    schema_sha256: schema.digest("hex"),
    tables,
  };
}
export async function verifyCompositionSnapshot(query: CompositionQuery, expected: CompositionSnapshotEvidence) {
  if ((await query({ kind: "foreign-keys" })).length) throw new Error("Restored composition foreign keys failed.");
  const actual = await captureCompositionSnapshot(query, expected.revision_id);
  if (!actual || canonicalJson(actual) !== canonicalJson(expected))
    throw new Error("Restored composition snapshot differs.");
}
