import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { documentStorage } from "./reconciliation-document";
import { retainPartitionedRecord, restorePartitionedRecord } from "./reconciliation-text";
import {
  retainSourceObservationStatement,
  sourceObservationStatement,
} from "./reconciliation-source-observation-repository";

type SourceObservationRow = { content: string; sha256: string };

/** Stage addressable records while the source document's verified bytes are already available. */
export async function retainSourceObservations(
  database: CatalogueStore,
  runId: string,
  setId: string,
  observations: unknown[],
) {
  let pending: { ordinal: number; content: string; sha256: string }[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!pending.length) return;
    const results = await documentStorage(() =>
      database.batch<SourceObservationRow>(
        pending.flatMap((record) => [
          retainSourceObservationStatement(database, runId, setId, record.ordinal, record.content, record.sha256),
          sourceObservationStatement(database, runId, setId, record.ordinal),
        ]),
      ),
    );
    for (const [index, record] of pending.entries()) {
      const retained = results[index * 2 + 1]?.results[0];
      if (retained?.content !== record.content || retained.sha256 !== record.sha256)
        throw new Error("Retained source observation replay changed immutable content.");
    }
    pending = [];
    bytes = 0;
  };
  for (const [ordinal, observation] of observations.entries()) {
    const content = canonicalJson(await retainPartitionedRecord(database, runId, canonicalJson(observation)));
    const size = new TextEncoder().encode(content).byteLength;
    if (size > 512000)
      throw new Error("reconciliation_capacity_exceeded: one source observation exceeds 512 KiB metadata.");
    if (pending.length === 8 || bytes + size > 512000) await flush();
    pending.push({ ordinal, content, sha256: await sha256Text(content) });
    bytes += size;
  }
  await flush();
}

export async function readSourceObservation(
  database: CatalogueStore,
  runId: string,
  setId: string,
  ordinal: number,
): Promise<unknown> {
  const record = await documentStorage(() =>
    sourceObservationStatement(database, runId, setId, ordinal).first<SourceObservationRow>(),
  );
  if (!record || (await sha256Text(record.content)) !== record.sha256)
    throw new Error("Retained source observation failed integrity verification.");
  return JSON.parse((await restorePartitionedRecord(database, runId, JSON.parse(record.content))) as string) as unknown;
}
