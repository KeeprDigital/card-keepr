import { type CatalogueStore, canonicalJson, sha256Text, utf8 } from "../shared";
import { attachRecordManifest, recordManifest, retainSourceAuxiliary } from "./source-record-auxiliary-repository";
export async function retainSourceRecordManifest(db: CatalogueStore, set: string, manifest: Record<string, unknown>) {
  const content = canonicalJson(manifest);
  if (utf8(content).byteLength > 32768) throw new Error("Source record manifest exceeds 32 KiB.");
  const sha256 = await sha256Text(content);
  await db.batch([
    retainSourceAuxiliary(db, set, "manifest", "", { ordinal: 0, content, sha256 }),
    attachRecordManifest(
      db,
      set,
      sha256,
      (manifest.record_storage as { requests?: { count: number; sha256: string } }).requests,
    ),
  ]);
  const receipt = await recordManifest(db, set).first<{ content: string; sha256: string }>();
  if (receipt?.content !== content || receipt.sha256 !== sha256)
    throw new Error("Source record manifest replay changed.");
}
export async function readSourceRecordManifest(
  db: CatalogueStore,
  set: string,
  digest: string,
  read: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation(),
) {
  const row = await read(() => recordManifest(db, set).first<{ content: string; sha256: string }>());
  if (!row || row.sha256 !== digest || (await sha256Text(row.content)) !== digest)
    throw new Error("Source record manifest changed.");
  return JSON.parse(row.content) as Record<string, unknown>;
}
