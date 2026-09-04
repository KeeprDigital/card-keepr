// Public surface of the `adapters` cluster: Source Adapter Version
// registrations and the Official Source parsers behind them. Parser bodies
// stay internal (ADR 0004); consumers reach them through the registration
// helpers. See ../README.md (issue #96).

export {
  adapterReconciliationAreas,
  assertAdapterBinding,
  assertAdapterRequestSurface,
  assertOfficialSourceUrl,
  globalEmergencySourceRequestCeiling,
  installedSourceAdapterRegistrations,
  registeredLegalitySourceScope,
  requiredActiveSourceAdapter,
  requiredOfficialSourceContract,
  requiredSourceAdapter,
  sourceAdapterRegistrations,
  type ListingReconciliationTraits,
  type OfficialSourceContract,
  type SourceAdapterRegistration,
} from "./source-adapters";
export {
  requiredLegalityRegionsForGame,
  requiredOfficialSourceScope,
  type OfficialSourceScope,
} from "./official-source-scope";
export { officialSourceDiscoveryRequests } from "./product-release-source-adapters";
export {
  parsedOfficialArtworkIdentity,
  type OfficialArtworkIdentity,
} from "./official-artwork-identity";
export { parseOnePieceOfficialErrataHtml } from "./one-piece-official-errata-html";
export { officialLegalityRulesObservation } from "./official-legality-source-adapters";
