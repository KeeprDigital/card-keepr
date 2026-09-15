import type { SourceAdapterRegistration } from "../../../src/catalogue/adapters/source-adapter-registration-types";

export const retainedParentContextAdapter = {
  adapterVersion: "fixture-retained-parent-context@1",
  sourceLineage: "tcgdex-pokemon-en",
  supportedGame: "pokemon",
  gameProfileVersion: "pokemon@1",
  parserContract: "synthetic-retained-parent-context@1",
  maximumSnapshotBytes: 1024,
  requestCapacity: 10,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "source_qualification",
  retainedParentContext: { maximumDepth: 3, maximumTotalBytes: 1024 },
  discoverRequests: (_bytes, context) =>
    context.url === "https://source.invalid/revalidation/root"
      ? [{ role: "listing", url: "https://source.invalid/revalidation/child", headers: { accept: "application/json" } }]
      : [],
  parseBytes: (_bytes, context) => [
    {
      parent_evidence: (context.parents ?? []).map((parent) => ({
        request_id: parent.requestId,
        snapshot_id: parent.snapshotId,
        retrieved_at: parent.retrievedAt,
        url: parent.url,
        sha256: parent.contentSha256,
        text: new TextDecoder().decode(parent.bytes),
      })),
    },
  ],
} satisfies SourceAdapterRegistration;
