import {
  restoreSourceRecordText,
  type SourceRecordEnvelope,
  sealedSourceRecordProgress,
  sourceRecordAt,
  sourceRecordPage,
  type SourceRecordRow,
} from "../source-evidence";
import { type CatalogueStore, sha256Text } from "../shared";
import { documentStorage } from "./reconciliation-document";
export async function readSourceObservation(
  database: CatalogueStore,
  setId: string,
  ordinal: number,
): Promise<unknown> {
  if (!(await sealedSourceRecordProgress(database, setId, documentStorage)))
    throw new Error("source_record_migration_required: explicitly import retained observations before preparation.");
  const record = await documentStorage(() => sourceRecordAt(database, setId, ordinal).first<SourceRecordRow>());
  return restoreObservation(database, setId, record);
}

/** Keep one byte-bounded page while consuming a sealed observation prefix. */
export async function* readSourceObservations(database: CatalogueStore, setId: string, start: number, count: number) {
  if (!(await sealedSourceRecordProgress(database, setId, documentStorage)))
    throw new Error("source_record_migration_required: explicitly import retained observations before preparation.");
  let ordinal = start;
  while (ordinal < count) {
    const page = await documentStorage(() => sourceRecordPage(database, setId, ordinal - 1).all<SourceRecordRow>());
    if (!page.results.length) throw new Error("Retained source observation is missing.");
    for (const record of page.results) {
      if (ordinal >= count) return;
      if (record.ordinal !== ordinal) throw new Error("Retained source observation sequence is incomplete.");
      yield { ordinal, value: await restoreObservation(database, setId, record) };
      ordinal++;
    }
  }
}

async function restoreObservation(database: CatalogueStore, setId: string, record: SourceRecordRow | null) {
  if (!record || (await sha256Text(record.content)) !== record.sha256)
    throw new Error("Retained source observation failed integrity verification.");
  const wrapped = JSON.parse(record.content) as Record<string, unknown>;
  const parts = wrapped.source_text_parts as SourceRecordEnvelope["text_parts"] | undefined;
  delete wrapped.source_text_parts;
  return parts
    ? restoreSourceRecordText(
        database,
        setId,
        {
          contract: "card-keepr-source-record-envelope@1",
          value: wrapped,
          text_parts: parts,
        },
        documentStorage,
      )
    : wrapped;
}
