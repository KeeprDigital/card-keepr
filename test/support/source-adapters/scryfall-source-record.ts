import type { SourceAdapterRegistration } from "../../../src/catalogue/adapters/source-adapters";
import { scryfallSourceAdapterRegistration as scryfall } from "../../../src/catalogue/adapters/scryfall-source-adapter";

// Carries real Scryfall adapter output through fixture transport with the
// production admission traits, so reconciliation sees exactly what a
// facts-only (tranche 0) run retains: image claims without image bytes.
export const scryfallSourceRecordAdapter: SourceAdapterRegistration = {
  adapterVersion: "fixture-scryfall-source-record@1",
  sourceLineage: scryfall.sourceLineage,
  supportedGame: scryfall.supportedGame,
  gameProfileVersion: scryfall.gameProfileVersion,
  parserContract: "synthetic-fixture-card-document@2",
  maximumSnapshotBytes: 1024 * 1024,
  requestCapacity: 10,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: scryfall.printingAdmission,
  printingNoveltyProof: scryfall.printingNoveltyProof,
  qualifiesCardDesignIdentity: scryfall.qualifiesCardDesignIdentity,
  qualifiesPrintingIdentity: scryfall.qualifiesPrintingIdentity,
  jsonRecordContainers: ["cards"],
  parse(document) {
    if (!document || typeof document !== "object" || !("cards" in document) || !Array.isArray(document.cards))
      return [];
    return document.cards;
  },
};
