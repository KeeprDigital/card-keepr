import { tcgdexCardContent } from "../../../src/catalogue/adapters/tcgdex-card-content";
import { qualifiedTcgdexCard, tcgdexDiscoveryRequests } from "../../../src/catalogue/adapters/tcgdex-discovery";
import type { SourceAdapterRegistration } from "../../../src/catalogue/adapters/source-adapter-registration-types";

/** Production parsing functions over original bytes; qualification observations
 * deliberately do not claim catalogue admission or a complete source collection. */
export const tcgdexRetainedGraphAdapter = {
  adapterVersion: "fixture-tcgdex-retained-graph@1",
  sourceLineage: "tcgdex-pokemon-en",
  supportedGame: "pokemon",
  gameProfileVersion: "pokemon@1",
  parserContract: "retained-tcgdex-graph-qualification@1",
  maximumSnapshotBytes: 1024 * 1024,
  requestCapacity: 1000,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "source_qualification",
  retainedParentContext: { maximumDepth: 3, maximumTotalBytes: 3 * 1024 * 1024 },
  discoverRequests: (bytes, context) =>
    context.url.includes("/cards/") ? [] : tcgdexDiscoveryRequests(bytes, context),
  parseBytes: (bytes, context) => {
    if (!context.url.includes("/cards/")) return [{ inventory_url: context.url }];
    const { card, ...qualified } = qualifiedTcgdexCard(bytes, context);
    return [
      {
        qualification: { ...qualified, content: tcgdexCardContent(card) },
        source_record_json: JSON.stringify(card),
        parent_evidence: context.parents!.map(({ bytes: _bytes, ...parent }) => parent),
      },
    ];
  },
} satisfies SourceAdapterRegistration;
