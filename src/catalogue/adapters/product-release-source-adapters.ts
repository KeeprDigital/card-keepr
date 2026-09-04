import { AdapterParseFailure } from "./adapter-parse-failure";
import { onePieceAdapter } from "./one-piece-adapter";
import { fusionWorldAdapter } from "./fusion-world-adapter";
import { digimonAdapter } from "./digimon-adapter";
import { gundamAdapters } from "./gundam-adapter";
import type { OfficialRawAdapterContract } from "./adapter-contract";
export type { OfficialRawAdapterContract } from "./adapter-contract";
export const officialRawAdapterContracts: readonly OfficialRawAdapterContract[] = Object.freeze([
  onePieceAdapter,
  fusionWorldAdapter,
  digimonAdapter,
  ...gundamAdapters,
]);

export function officialSourceDiscoveryRequests(sourceLineage: string): readonly {
  id: string;
  method: "GET";
  url: string;
  headers: Record<string, string>;
}[] {
  const contract = officialRawAdapterContracts
    .filter((adapterContract) => adapterContract.sourceLineage === sourceLineage)
    .at(-1);
  if (contract === undefined) {
    throw new AdapterParseFailure("Official Source lineage has no discovery contract.", { category: "configuration" });
  }
  if (contract.requestUrlForDiscovery === undefined) {
    throw new AdapterParseFailure("Official Source lineage has no active discovery root.", {
      category: "configuration",
    });
  }
  return [
    {
      id: `${sourceLineage}:discovery`,
      method: "GET",
      url: contract.requestUrlForDiscovery(),
      headers: { accept: "text/html" },
    },
  ];
}
