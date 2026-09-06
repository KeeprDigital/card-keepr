import { correctionDecisionPinMetadata } from "./identity-correction-pins";
import { entityAdmissionPinMetadata } from "./entity-admission-pins";
import { type CatalogueStore, type CatalogueCandidate, canonicalJson, sha256Text } from "../shared";
import {
  insertReconciliationPartitionStatement,
  reconciliationPartitionStatement,
  reconciliationOperationStatement,
} from "./reconciliation-progress-repository";

const maximumPartitionBytes = 512 * 1024;
const maximumPartitionRecords = 500;

/** Each independently hashed metadata partition is bounded before a D1 write. */
export async function persistCandidatePartitions(
  database: CatalogueStore,
  runId: string,
  candidate: CatalogueCandidate,
  warnings: readonly unknown[] = [],
) {
  let ordinal = 0;
  const pins = await reconciliationOperationStatement(database, runId).first<{
    definition_pins_json: string;
    input_manifest_digest: string;
    observation_cutoff: number;
    identity_decision_cutoff: number;
    authority_decision_cutoff: number;
    created_at: string;
    deadline: string;
  }>();
  if (!pins) throw new Error("Reconciliation pins are unavailable.");
  let digest = await sha256Text(
    canonicalJson({
      contract: "card-keepr-sealed-candidate-manifest@1",
      run_id: runId,
      definitions: pins.definition_pins_json,
      input_manifest: pins.input_manifest_digest,
      admissions: await entityAdmissionPinMetadata(database, runId),
      corrections: await correctionDecisionPinMetadata(database, runId),
      observations: pins.observation_cutoff,
      identities: pins.identity_decision_cutoff,
      authorities: pins.authority_decision_cutoff,
      created_at: pins.created_at,
      deadline: pins.deadline,
    }),
  );
  for (const [kind, records] of Object.entries({ ...candidate, warnings })) {
    if (!Array.isArray(records)) continue;
    let parts: string[] = [];
    let bytes = 2;
    const flush = async () => {
      if (parts.length === 0) return;
      const content = `[${parts.join(",")}]`;
      await insertReconciliationPartitionStatement(database, {
        runId,
        ordinal,
        kind,
        content,
        sha256: await sha256Text(content),
        bytes,
        records: parts.length,
      }).run();
      const retained = await reconciliationPartitionStatement(database, runId, ordinal).first<{
        kind: string;
        content: string;
      }>();
      if (retained?.kind !== kind || retained.content !== content)
        throw new Error("Reconciliation partition replay differs from its immutable content.");
      digest = await sha256Text(
        canonicalJson({
          previous: digest,
          ordinal,
          kind,
          sha256: await sha256Text(content),
          bytes,
          records: parts.length,
        }),
      );
      ordinal++;
      parts = [];
      bytes = 2;
    };
    for (const record of records) {
      const encoded = canonicalJson(record);
      const length = new TextEncoder().encode(encoded).byteLength;
      if (length + 2 > maximumPartitionBytes)
        throw new Error("reconciliation_capacity_exceeded: one metadata record exceeds 512 KiB.");
      if (parts.length === maximumPartitionRecords || bytes + length + (parts.length ? 1 : 0) > maximumPartitionBytes)
        await flush();
      bytes += length + (parts.length ? 1 : 0);
      parts.push(encoded);
    }
    await flush();
  }
  return { digest, count: ordinal };
}
