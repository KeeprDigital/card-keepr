import { tcgdexPokemonSourceAdapterRegistration } from "../../../src/catalogue/adapters/tcgdex-pokemon-source-adapter";
import type { SourceAdapterRegistration } from "../../../src/catalogue/adapters/source-adapter-registration-types";

const urls = new Set([
  "https://api.tcgdex.net/v2/en/sets",
  "https://api.tcgdex.net/v2/en/series/tcgp",
  "https://api.tcgdex.net/v2/en/sets/base1",
  "https://api.tcgdex.net/v2/en/cards/base1-98",
  "https://assets.tcgdex.net/en/base/base1/98/high.png",
]);

/** A separately declared five-request fixture, never completion of the full
 * production graph. All bytes and Card membership use production validation. */
export const tcgdexReviewRecordAdapter = {
  ...tcgdexPokemonSourceAdapterRegistration,
  adapterVersion: "fixture-tcgdex-review-record@1",
  parserContract: "fixture-tcgdex-review-record@1",
  requestCapacity: 5,
  requiredSurfaces: ["english-set-inventory"],
  requestUrlForSurface: () => "https://api.tcgdex.net/v2/en/sets",
  coverageContracts: undefined,
  discoverRequests(bytes, context) {
    return tcgdexPokemonSourceAdapterRegistration
      .discoverRequests(bytes, context)
      .filter((request) => urls.has(request.url));
  },
} satisfies SourceAdapterRegistration;
