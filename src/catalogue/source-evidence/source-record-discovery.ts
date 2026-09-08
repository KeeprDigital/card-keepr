import { type CatalogueStore, AdministrationProblem, canonicalJson, sha256Text, utf8 } from "../shared";
import { AdapterParseFailure, type SourceAdapterRegistration } from "../adapters";
import {
  retainSourceAuxiliary,
  sourceAuxiliaryPage,
  discoveryFactsForSurface,
  discoveryParentFact,
  discoveryRootSet,
  type SourceAuxiliaryRow,
} from "./source-record-auxiliary-repository";
import { completeOfficialCollectionRequestsFromDiscovery } from "./source-evidence-model";
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export async function retainSourceDiscoveryFacts(db: CatalogueStore, set: string, value: unknown) {
  if (!object(value) || value.observation_type !== "official_surface_evidence" || value.surface !== "discovery") return;
  if (!Array.isArray(value.records) || value.records.length > 256)
    throw new AdapterParseFailure("Discovery page exceeds its bounded surface vocabulary.");
  for (const [ordinal, fact] of value.records.entries()) {
    if (!object(fact) || typeof fact.surface !== "string")
      throw new AdapterParseFailure("Discovery fact has no surface identity.");
    const content = canonicalJson(fact);
    if (utf8(content).byteLength > 8192) throw new AdapterParseFailure("Discovery fact exceeds 8 KiB.");
    const row = { ordinal, content, sha256: await sha256Text(content) };
    await retainSourceAuxiliary(db, set, "discovery", fact.surface, row).run();
    const receipt = (
      await sourceAuxiliaryPage(db, set, "discovery", fact.surface, ordinal - 1, 1).all<SourceAuxiliaryRow>()
    ).results[0];
    if (canonicalJson(receipt) !== canonicalJson(row)) throw new Error("Discovery fact replay changed.");
  }
}
export async function indexedOfficialCollectionRequests(
  db: CatalogueStore,
  run: string,
  adapter: SourceAdapterRegistration,
  headers: Readonly<Record<string, string>>,
) {
  if (!adapter.requiredSurfaces || adapter.requiredSurfaces.length > 32)
    throw new Error("Official source surface vocabulary is unbounded.");
  const records: unknown[] = [];
  const decode = async (row: { content: string; sha256: string }) => {
    if ((await sha256Text(row.content)) !== row.sha256) throw new Error("Discovery fact digest changed.");
    return JSON.parse(row.content) as Record<string, unknown>;
  };
  for (const surface of adapter.requiredSurfaces) {
    const rows = (
      await discoveryFactsForSurface(db, run, adapter.sourceLineage, surface).all<{ content: string; sha256: string }>()
    ).results;
    if (!rows.length) return null;
    if (rows.length !== 1)
      throw new AdministrationProblem(
        422,
        "source_discovery_failed",
        `Official Source discovery duplicates the ${surface} surface.`,
      );
    const fact = await decode(rows[0]!);
    records.push(fact);
    if (object(fact.discovered_from) && fact.discovered_from.kind === "retained_stage_request") {
      const parent = await discoveryParentFact(db, run, adapter.sourceLineage, String(fact.url)).first<{
        content: string;
        sha256: string;
      }>();
      if (parent) records.push(await decode(parent));
    }
  }
  const root = await discoveryRootSet(db, run, adapter.sourceLineage).first<{ observation_set_id: string }>();
  if (!root) throw new Error("Official Source discovery root is unavailable.");
  const requests = await completeOfficialCollectionRequestsFromDiscovery(adapter, records, headers);
  return requests === null ? null : { discoveryObservationSetId: root.observation_set_id, requests };
}
