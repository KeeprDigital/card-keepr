import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { boundedRecordArrays } from "./reconciliation-preparation";
import {
  insertReconciliationInputPartitionStatement,
  reconciliationInputManifestStatement,
  reconciliationInputPartitionStatement,
  sealReconciliationInputStatement,
} from "./reconciliation-input-repository";

export class ReconciliationInputStorageError extends Error {
  constructor(cause: unknown) {
    super("Reconciliation input storage is temporarily unavailable.", { cause });
    this.name = "ReconciliationInputStorageError";
  }
}
async function storage<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    throw new ReconciliationInputStorageError(cause);
  }
}

/** Inputs become reusable only after all verification and partition writes complete. */
export async function retainVerifiedReconciliationInput(
  database: CatalogueStore,
  runId: string,
  input: Record<string, unknown>,
) {
  let ordinal = 0;
  let digest = await sha256Text(canonicalJson({ contract: "card-keepr-reconciliation-input@1", run_id: runId }));
  const metadata = Object.fromEntries(Object.entries(input).filter(([, value]) => !Array.isArray(value)));
  const groups: [string, Iterable<unknown>][] = [
    ["$metadata", [{ values: metadata, array_keys: Object.keys(input).filter((key) => Array.isArray(input[key])) }]],
  ];
  for (const [kind, value] of Object.entries(input)) if (Array.isArray(value)) groups.push([kind, value]);
  for (const [kind, records] of groups) {
    for (const content of boundedRecordArrays(withoutUndefined(records))) {
      const sha256 = await sha256Text(content);
      await storage(insertReconciliationInputPartitionStatement(database, runId, ordinal, kind, content, sha256).run());
      const retained = await storage(
        reconciliationInputPartitionStatement(database, runId, ordinal).first<{
          kind: string;
          content: string;
          sha256: string;
        }>(),
      );
      if (retained?.kind !== kind || retained.content !== content || retained.sha256 !== sha256)
        throw new Error("Reconciliation input replay changed its immutable content.");
      digest = await sha256Text(canonicalJson({ previous: digest, ordinal, kind, sha256 }));
      ordinal++;
    }
  }
  await storage(sealReconciliationInputStatement(database, runId, digest, ordinal).run());
}

/** Legacy computation consumes the verified records; input reads themselves are page bounded. */
export async function readVerifiedReconciliationInput(
  database: CatalogueStore,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const manifest = await storage(
    reconciliationInputManifestStatement(database, runId).first<{ input_manifest_digest: string | null }>(),
  );
  if (!manifest?.input_manifest_digest) return null;
  let digest = await sha256Text(canonicalJson({ contract: "card-keepr-reconciliation-input@1", run_id: runId }));
  const result: Record<string, unknown> = {};
  for (let ordinal = 0; ; ordinal++) {
    const partition = await storage(
      reconciliationInputPartitionStatement(database, runId, ordinal).first<{
        kind: string;
        content: string;
        sha256: string;
      }>(),
    );
    if (!partition) break;
    if ((await sha256Text(partition.content)) !== partition.sha256)
      throw new Error("Retained reconciliation input partition failed integrity verification.");
    const records = JSON.parse(partition.content) as unknown[];
    if (partition.kind === "$metadata") {
      const metadata = records[0] as { values: Record<string, unknown>; array_keys: string[] };
      Object.assign(result, metadata.values);
      for (const key of metadata.array_keys) result[key] = [];
    } else {
      const values = (result[partition.kind] ??= []) as unknown[];
      values.push(...records);
    }
    digest = await sha256Text(
      canonicalJson({ previous: digest, ordinal, kind: partition.kind, sha256: partition.sha256 }),
    );
  }
  if (digest !== manifest.input_manifest_digest)
    throw new Error("Retained reconciliation input manifest failed verification.");
  return result;
}

function* withoutUndefined(records: Iterable<unknown>): Generator<unknown> {
  for (const record of records) yield JSON.parse(JSON.stringify(record));
}
