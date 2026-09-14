import type { SourceAdapterRegistration } from "../../../src/catalogue/adapters/source-adapters";

// Synthetic, independently namespaced design evidence. No real source coverage claim.
export const designIdentityAdapters: readonly SourceAdapterRegistration[] = [
  "one-piece-en",
  "limitless-one-piece-en",
].map((sourceLineage) => ({
  adapterVersion: `fixture-design-${sourceLineage}@1`,
  sourceLineage,
  supportedGame: "one-piece",
  gameProfileVersion: "one-piece@1",
  parserContract: "synthetic-source-design@1",
  maximumSnapshotBytes: 1024 * 1024,
  requestCapacity: 10,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "source_qualification",
  qualifiesCardDesignIdentity: (evidence) => evidence.cardDesignKey?.startsWith("qualified:") === true,
  qualifiesPrintingIdentity: () => true,
  jsonRecordContainers: ["cards"],
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    const document = JSON.parse(new TextDecoder().decode(bytes)) as {
      cards: { appearance_evidence?: { images: { source_url: string; content_base64?: string }[] } }[];
    };
    return document.cards.flatMap((card) =>
      (card.appearance_evidence?.images ?? [])
        .filter((image) => image.content_base64 === undefined)
        .map((image) => ({ role: "image" as const, url: image.source_url, headers: { accept: "image/png" } })),
    );
  },
  parseBytes(bytes, context) {
    return context.mediaType?.startsWith("image/") ? [] : JSON.parse(new TextDecoder().decode(bytes)).cards;
  },
  parse(document) {
    if (!document || typeof document !== "object" || !("cards" in document) || !Array.isArray(document.cards))
      return [];
    return document.cards;
  },
}));
