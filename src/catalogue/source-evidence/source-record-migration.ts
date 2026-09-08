import {
  AdministrationProblem,
  type CatalogueStore,
  canonicalJson,
  resumableObjectMembers,
  sha256Text,
  utf8,
} from "../shared";
import type { ObservationSetRow } from "./source-evidence-repository-types";
import {
  observationSetForRecordMigration,
  retainSourceAuxiliary,
  sourceAuxiliaryPage,
  type SourceAuxiliaryRow,
} from "./source-record-auxiliary-repository";
import { sourceRecordProgress, sealSourceRecords, type SourceRecordProgress } from "./source-record-repository";
import { retainExtractedSourceRecords, verifiedSnapshotChunks } from "./source-record-intake";
import { retainSourceRecordManifest } from "./source-record-manifest";

/** Explicit operator migration only. Original retained evidence is never rewritten. */
export async function importRetainedSourceRecords(db: CatalogueStore, bucket: R2Bucket, id: string) {
  const row = await observationSetForRecordMigration(db, id).first<ObservationSetRow>();
  if (!row)
    throw new AdministrationProblem(404, "source_observation_set_not_found", "Source Observation Set is unavailable.");
  const progress = await sourceRecordProgress(db, id).first<SourceRecordProgress>();
  if (progress?.sealed === 1 && progress.authoritative !== 1)
    throw new AdministrationProblem(
      409,
      "source_record_migration_unavailable",
      "Retained evidence has entered cleanup.",
    );
  if (progress?.sealed === 1 && progress.manifest_digest)
    return { observation_set_id: id, state: "sealed", observation_count: progress.next_ordinal };
  if (row.content_byte_length > 67108864 || row.observation_count > 2048)
    throw new AdministrationProblem(
      422,
      "source_record_migration_capacity",
      "Explicit import accepts at most 64 MiB and 2048 retained observations per set.",
    );
  const source = () => verifiedSnapshotChunks(bucket, row);
  const limits = {
    maximumTokenCharacters: 16777216,
    maximumTokenBytes: 16777216,
    maximumStructuralTokens: 16384,
    maximumDepth: 128,
  };
  const header: Record<string, unknown> = {};
  let count = 0,
    members = 0,
    observations = false;
  for await (const { member } of resumableObjectMembers(source, null, limits)) {
    if (++members > 4096) throw new Error("Retained observation document exceeds its member budget.");
    if (member.key === "observations") {
      if (member.kind === "array") observations = true;
      else if (!member.array) throw new Error("Retained observations must be an array.");
      else if (++count > row.observation_count) throw new Error("Retained observation count changed.");
    } else {
      if (member.kind !== "value" || member.array)
        throw new Error("Retained observation header must contain bounded values.");
      Object.defineProperty(header, member.key, { value: member.value, enumerable: true, writable: true });
      if (utf8(canonicalJson(header)).length > 32768) throw new Error("Retained observation header exceeds 32 KiB.");
    }
  }
  if (progress?.sealed === 1) {
    const storage = header.record_storage as { count?: number; sha256?: string } | undefined;
    if (observations || storage?.count !== progress.next_ordinal || storage.sha256 !== progress.digest)
      throw new Error("Retained manifest differs from its sealed records.");
    const requests = await importManifestRequests(db, id, JSON.parse(progress.header_json).requests);
    await retainSourceRecordManifest(db, id, { ...header, record_storage: { ...storage, requests } });
  } else {
    if (!observations || count !== row.observation_count) throw new Error("Retained observation count changed.");
    const manifest = await retainExtractedSourceRecords(db, id, header, {
      count,
      pagination: null,
      requests: [],
      records: (async function* () {
        let ordinal = 0;
        for await (const { member } of resumableObjectMembers(source, null, limits)) {
          if (member.kind !== "value" || !member.array || member.key !== "observations") continue;
          const wrapped = member.value as { id?: string; ordinal?: number; value?: unknown } | null;
          ordinal++;
          if (
            !wrapped ||
            wrapped.id !== `srcobs_${id.slice(10)}_${ordinal}` ||
            wrapped.ordinal !== ordinal ||
            !("value" in wrapped)
          )
            throw new Error("Retained observation identity does not match its original set and ordinal.");
          yield { sourceKey: String(ordinal - 1), value: wrapped.value, request: null };
        }
      })(),
    });
    // The retained header remains the historical authority, including its summary.
    await retainSourceRecordManifest(db, id, { ...manifest, ...header, record_storage: manifest.record_storage });
    await sealSourceRecords(db, id).run();
  }
  return { observation_set_id: id, state: "sealed", observation_count: row.observation_count };
}

/** Migration 29 had small inline request metadata. Only this explicit importer reads it. */
async function importManifestRequests(db: CatalogueStore, set: string, requests: unknown) {
  if (!Array.isArray(requests) || utf8(canonicalJson(requests)).length > 32768)
    throw new Error("Legacy manifest requests exceed their retained header budget.");
  let digest = await sha256Text(canonicalJson({ contract: "card-keepr-source-requests@1", set }));
  let pending: SourceAuxiliaryRow[] = [];
  const flush = async () => {
    if (!pending.length) return;
    await db.batch(pending.map((row) => retainSourceAuxiliary(db, set, "request", "", row)));
    const rows = (
      await sourceAuxiliaryPage(
        db,
        set,
        "request",
        "",
        pending[0]!.ordinal - 1,
        pending.length,
      ).all<SourceAuxiliaryRow>()
    ).results;
    if (canonicalJson(rows) !== canonicalJson(pending)) throw new Error("Legacy request migration replay changed.");
    pending = [];
  };
  for (const [ordinal, request] of requests.entries()) {
    const content = canonicalJson(request);
    if (utf8(content).length > 4096) throw new Error("Legacy manifest request exceeds 4 KiB.");
    const row = { ordinal, content, sha256: await sha256Text(content) };
    digest = await sha256Text(canonicalJson({ previous: digest, ordinal, sha256: row.sha256 }));
    pending.push(row);
    if (pending.length === 8) await flush();
  }
  await flush();
  return { count: requests.length, sha256: digest };
}
