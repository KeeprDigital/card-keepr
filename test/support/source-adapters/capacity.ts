import type {
  SourceAdapterRegistration,
  ExtractedSourceRequest,
} from "../../../src/catalogue/adapters/source-adapter-registration-types";
import {
  capacityMaximumPageBytes,
  capacityCollectionScopes,
  syntheticCapacityWorkloads,
  capacityPageCount,
  capacityPageUrl,
  capacityPrintingsPerPage,
  syntheticCapacityTier,
} from "../fake-publisher/capacity-workloads";

// A synthetic fixture adapter only. Production request limits and source
// contracts remain unchanged; the measurement must record any capacity pause.
export const capacitySourceAdapter = {
  adapterVersion: "fixture-one-piece-capacity@1",
  printingAdmission: "source_qualification",
  sourceLineage: "one-piece-en",
  supportedGame: "one-piece",
  gameProfileVersion: "one-piece@1",
  parserContract: "synthetic-capacity-separate-images@1",
  maximumSnapshotBytes: capacityMaximumPageBytes,
  requestCapacity: 5000,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  coverageContracts: Object.fromEntries(
    syntheticCapacityWorkloads.flatMap((workload) =>
      capacityCollectionScopes(workload).map((scope) => [
        scope.subset,
        {
          description: `Complete synthetic Card inventories on pages ${scope.firstPage}–${scope.lastPage} of ${workload.id}.`,
          requiredSurfaces: ["catalogue"],
          requestUrlForSurface: (surface: string) => {
            if (surface !== "catalogue") throw new Error("Unknown capacity scope surface");
            return `${capacityPageUrl(workload.id, scope.firstPage)}?scope=${scope.subset}`;
          },
          // Resolve only the selected bounded identity set, never the entire tier inventory.
          get cardIdentities() {
            return Array.from({ length: scope.printings }, (_, offset) => ({
              kind: "card_number",
              value: `SYN-${String(scope.firstPage * capacityPrintingsPerPage + offset + 1).padStart(6, "0")}`,
            }));
          },
        },
      ]),
    ),
  ),
  recordExtraction: {
    matches: ({ url }) =>
      /^https:\/\/official-source\.invalid\/reconciliation\/capacity-(tier-[12]|2-images|128-images|accounting-pilot)-page-[0-9]+$/u.test(
        new URL(url).origin + new URL(url).pathname,
      ),
    async extract(source, context) {
      const match = /\/capacity-(tier-[12]|2-images|128-images|accounting-pilot)-page-([0-9]+)$/u.exec(
        new URL(context.url).pathname,
      );
      if (!match) throw new Error("Capacity source page URL is outside the fixture contract");
      const workload = syntheticCapacityTier(match[1]!);
      const page = Number(match[2]);
      const url = new URL(context.url);
      const subset = url.searchParams.get("scope");
      const scope = subset === null ? null : capacityCollectionScopes(workload).find((item) => item.subset === subset);
      if (subset !== null && (!scope || page < scope.firstPage || page > scope.lastPage))
        throw new Error("Capacity source page is outside its declared scope");
      if (`${capacityPageUrl(workload.id, page)}${subset === null ? "" : `?scope=${subset}`}` !== context.url)
        throw new Error("Capacity source page URL is not canonical");
      let text = "";
      let bytes = 0;
      for await (const chunk of source()) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > capacityMaximumPageBytes) throw new Error("Capacity source page exceeds its bounded byte budget");
        text += chunk;
      }
      const document = JSON.parse(text) as { cards: { appearance_evidence: { images: { source_url: string }[] } }[] };
      const expected = Math.min(capacityPrintingsPerPage, workload.printings - page * capacityPrintingsPerPage);
      if (!Array.isArray(document.cards) || document.cards.length !== expected)
        throw new Error("Capacity source page record census differs from the declared workload");
      const requests: ExtractedSourceRequest[] = [];
      if (page < (scope?.lastPage ?? capacityPageCount(workload) - 1))
        requests.push({
          role: "listing",
          url: `${capacityPageUrl(workload.id, page + 1)}${subset === null ? "" : `?scope=${subset}`}`,
          headers: { accept: "application/json" },
        });
      for (const [offset, card] of document.cards.entries()) {
        const images = card.appearance_evidence?.images;
        const imagesPerPrinting = workload.images / workload.printings;
        if (!Array.isArray(images) || images.length !== imagesPerPrinting)
          throw new Error("Capacity source page image census differs from the declared workload");
        for (const [face, image] of images.entries()) {
          const index = (page * capacityPrintingsPerPage + offset) * imagesPerPrinting + face;
          if (image.source_url !== `https://official-source.invalid/images/capacity-${workload.id}-${index}.png`)
            throw new Error("Capacity source image URL differs from the declared workload");
          requests.push({ role: "image", url: image.source_url, headers: { accept: "image/png" } });
        }
      }
      return {
        count: document.cards.length,
        pagination: null,
        requests,
        records: (async function* () {
          for (const [index, value] of document.cards.entries())
            yield { sourceKey: String(index), value, request: null };
        })(),
      };
    },
  },
} satisfies SourceAdapterRegistration;
