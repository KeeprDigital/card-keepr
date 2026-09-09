import { type CatalogueStore, sha256Text, utf8 } from "../shared";
import {
  type SourceRecordProgress,
  type SourceRecordRow,
  sourceRecordAt,
  sourceRecordProgress,
} from "./source-record-repository";

/** Resolve the canonical observation identity with two exact retained-record reads. */
export async function retainedSourceObservationExists(database: CatalogueStore, id: string): Promise<boolean> {
  const identity = /^srcobs_([a-f0-9]{64})_([1-9][0-9]*)$/u.exec(id);
  if (!identity) return false;
  const ordinal = Number(identity[2]);
  if (!Number.isSafeInteger(ordinal)) return false;
  const set = `srcobsset_${identity[1]}`;
  const progress = await sourceRecordProgress(database, set).first<SourceRecordProgress>();
  if (
    progress?.sealed !== 1 ||
    progress.authoritative !== 1 ||
    !progress.manifest_digest ||
    progress.requests_complete !== 1 ||
    ordinal > progress.next_ordinal
  )
    return false;
  const record = await sourceRecordAt(database, set, ordinal - 1).first<SourceRecordRow>();
  if (!record || utf8(record.content).byteLength > 512000 || (await sha256Text(record.content)) !== record.sha256)
    return false;
  const observation = JSON.parse(record.content) as { id?: unknown; ordinal?: unknown };
  return observation.id === id && observation.ordinal === ordinal;
}
