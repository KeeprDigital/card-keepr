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
  requiredActiveSourceAdapter,
  requiredOfficialSourceContract,
  requiredSourceAdapter,
  sourceAdapterRegistrations,
  type OfficialSourceContract,
  type SourceAdapterRegistration,
} from "./source-adapters";
export type { ListingReconciliationTraits } from "./source-adapter-registration-types";
export {
  requiredOfficialSourceScope,
  type OfficialSourceScope,
} from "./official-source-scope";
export { officialSourceDiscoveryRequests } from "./product-release-source-adapters";
export {
  parsedOfficialArtworkIdentity,
  type OfficialArtworkIdentity,
} from "./official-artwork-identity";
export { parseOnePieceOfficialErrataHtml } from "./one-piece-official-errata-html";

export { AdapterParseFailure } from "./adapter-parse-failure";

export { publishers, sources, sourceLineages, gameProfileRegistrations } from "./source-registry";

export { sourceAdapterForCoverage } from "./source-adapters";
