import { type CatalogueStore, canonicalJson, sha256Text, utf8 } from "../shared";
import { AdapterParseFailure, type SourceAdapterRegistration } from "../adapters";
import {
  advanceSourceRequests,
  retainSourceAuxiliary,
  sourceAuxiliaryPage,
  type SourceAuxiliaryRow,
} from "./source-record-auxiliary-repository";
import { sourceRecordProgress, type SourceRecordProgress } from "./source-record-repository";

type Requests = Awaited<ReturnType<NonNullable<SourceAdapterRegistration["recordExtraction"]>["extract"]>>["requests"];
export async function retainSourceRecordRequests(db: CatalogueStore, set: string, requests: Requests) {
  const progress = await sourceRecordProgress(db, set).first<SourceRecordProgress>();
  if (!progress) throw new Error("Source request progress is missing.");
  let ordinal = 0,
    digest = await sha256Text(canonicalJson({ contract: "card-keepr-source-requests@1", set }));
  let pending: SourceAuxiliaryRow[] = [];
  const flush = async () => {
    if (!pending.length) return;
    const first = pending[0]!.ordinal;
    await db.batch([
      ...pending.map((row) => retainSourceAuxiliary(db, set, "request", "", row)),
      advanceSourceRequests(db, set, first, ordinal, digest),
    ]);
    const receipt = (
      await sourceAuxiliaryPage(db, set, "request", "", first - 1, pending.length).all<SourceAuxiliaryRow>()
    ).results;
    if (canonicalJson(receipt) !== canonicalJson(pending))
      throw new Error("Source request replay changed immutable content.");
    pending = [];
  };
  for await (const request of requests) {
    if (ordinal >= 32768) throw new AdapterParseFailure("Source page exceeds 32768 discovered requests.");
    if (pending.length === 8) await flush();
    const content = canonicalJson(request);
    if (utf8(content).byteLength > 4096) throw new AdapterParseFailure("Source request exceeds 4 KiB.");
    const row = { ordinal, content, sha256: await sha256Text(content) };
    digest = await sha256Text(canonicalJson({ previous: digest, ordinal, sha256: row.sha256 }));
    ordinal++;
    if (ordinal === progress.requests_next_ordinal && digest !== progress.requests_digest)
      throw new Error("Source request prefix changed.");
    if (row.ordinal < progress.requests_next_ordinal) continue;
    pending.push(row);
  }
  await flush();
  if (ordinal < progress.requests_next_ordinal) throw new Error("Source request suffix disappeared.");
  await advanceSourceRequests(db, set, ordinal, ordinal, digest, true).run();
  const receipt = await sourceRecordProgress(db, set).first<SourceRecordProgress>();
  if (
    receipt?.requests_next_ordinal !== ordinal ||
    receipt.requests_digest !== digest ||
    receipt.requests_complete !== 1
  )
    throw new Error("Source request completion is missing.");
  return { count: ordinal, sha256: digest };
}
