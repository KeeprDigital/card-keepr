import { tcgdexPokemonSourceAdapterRegistration } from "../../../src/catalogue/adapters/tcgdex-pokemon-source-adapter";
import { tcgdexReviewEvidence } from "../../../src/catalogue/adapters/tcgdex-review-evidence";
import type { SourceAdapterRegistration } from "../../../src/catalogue/adapters/source-adapter-registration-types";

const cardUrl = "https://api.tcgdex.net/v2/en/cards/base1-98";
const urls = new Set([
  "https://api.tcgdex.net/v2/en/sets",
  "https://api.tcgdex.net/v2/en/series/tcgp",
  "https://api.tcgdex.net/v2/en/sets/base1",
  cardUrl,
  "https://assets.tcgdex.net/en/base/base1/98/high.png",
]);

/** A separately declared five-request fixture, never completion of the full
 * production graph. All bytes and Card membership use production validation;
 * its one Card stays an unresolved review record even though production now
 * qualifies it, so proposal evidence retention remains exercised. */
export const tcgdexReviewRecordAdapter = {
  ...tcgdexPokemonSourceAdapterRegistration,
  adapterVersion: "fixture-tcgdex-review-record@1",
  parserContract: "fixture-tcgdex-review-record@1",
  requestCapacity: 5,
  requiredSurfaces: ["english-set-inventory"],
  requestUrlForSurface: () => "https://api.tcgdex.net/v2/en/sets",
  coverageContracts: undefined,
  parseBytes(bytes, context) {
    if (context.url === cardUrl) return [tcgdexReviewEvidence(bytes, context)];
    return tcgdexPokemonSourceAdapterRegistration.parseBytes(bytes, context);
  },
  discoverRequests(bytes, context) {
    if (context.url === cardUrl)
      return tcgdexReviewEvidence(bytes, context).appearance_evidence.images.map((image) => ({
        role: "image" as const,
        url: image.source_url,
        headers: { accept: "image/png" },
      }));
    return tcgdexPokemonSourceAdapterRegistration
      .discoverRequests(bytes, context)
      .filter((request) => urls.has(request.url));
  },
} satisfies SourceAdapterRegistration;
