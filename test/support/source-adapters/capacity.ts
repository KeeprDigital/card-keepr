import type {
  SourceAdapterRegistration,
  ExtractedSourceRequest,
} from "../../../src/catalogue/adapters/source-adapter-registration-types";
import {
  capacityMaximumPageBytes,
  capacityPageCount,
  capacityPageUrl,
  capacityPrintingsPerPage,
  syntheticCapacityTier,
} from "../fake-publisher/capacity-workloads";

// A synthetic fixture adapter only. Production request limits and source
// contracts remain unchanged; the measurement must record any capacity pause.
export const capacitySourceAdapter = {
  adapterVersion: "fixture-one-piece-capacity@1",
  sourceLineage: "one-piece-en",
  supportedGame: "one-piece",
  gameProfileVersion: "one-piece@1",
  parserContract: "synthetic-capacity-separate-images@1",
  maximumSnapshotBytes: capacityMaximumPageBytes,
  requestCapacity: 5000,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  recordExtraction: {
    matches: ({ url }) =>
      /^https:\/\/official-source\.invalid\/reconciliation\/capacity-(tier-[12]|128-images)-page-[0-9]+$/u.test(url),
    async extract(source, context) {
      const match = /\/capacity-(tier-[12]|128-images)-page-([0-9]+)$/u.exec(context.url);
      if (!match) throw new Error("Capacity source page URL is outside the fixture contract");
      const workload = syntheticCapacityTier(match[1]!);
      const page = Number(match[2]);
      if (capacityPageUrl(workload.id, page) !== context.url)
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
      if (page + 1 < capacityPageCount(workload))
        requests.push({
          role: "listing",
          url: capacityPageUrl(workload.id, page + 1),
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
