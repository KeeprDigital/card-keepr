import {
  restoreSourceRecordText,
  type SourceRecordEnvelope,
  sealedSourceRecordProgress,
  sourceRecordAt,
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
