import { type CatalogueStore, sha256Text, utf8 } from "../shared";
import { retainedObservationAuthority, retainedObservationRecord } from "./curated-retained-evidence-repository";

/** Resolve the canonical observation identity with two exact retained-record reads. */
export async function retainedSourceObservationExists(database: CatalogueStore, id: string): Promise<boolean> {
  const identity = /^srcobs_([a-f0-9]{64})_([1-9][0-9]*)$/u.exec(id);
  if (!identity) return false;
  const ordinal = Number(identity[2]);
  if (!Number.isSafeInteger(ordinal)) return false;
  const set = `srcobsset_${identity[1]}`;
  const progress = await retainedObservationAuthority(database, set).first<{
    sealed: number;
    authoritative: number;
    manifest_digest: string | null;
    requests_complete: number;
    next_ordinal: number;
  }>();
  if (
    progress?.sealed !== 1 ||
    progress.authoritative !== 1 ||
    !progress.manifest_digest ||
    progress.requests_complete !== 1 ||
    ordinal > progress.next_ordinal
  )
    return false;
  const record = await retainedObservationRecord(database, set, ordinal - 1).first<{
    content: string;
    sha256: string;
  }>();
  if (!record || utf8(record.content).byteLength > 512000 || (await sha256Text(record.content)) !== record.sha256)
    return false;
  const observation = JSON.parse(record.content) as { id?: unknown; ordinal?: unknown };
  return observation.id === id && observation.ordinal === ordinal;
}
