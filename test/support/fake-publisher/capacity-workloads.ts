// Accepted synthetic input shapes, not measured retained storage or usable capacity.
export interface CapacityWorkload {
  readonly id: string;
  readonly printings: number;
  readonly images: number;
  readonly imageBytes: number;
  readonly structuredBytes: number;
}

export const syntheticCapacityTiers = [
  { id: "tier-1", printings: 10_000, images: 20_000, imageBytes: 5 * 1024 ** 3, structuredBytes: 100 * 1024 ** 2 },
  { id: "tier-2", printings: 100_000, images: 200_000, imageBytes: 50 * 1024 ** 3, structuredBytes: 1024 ** 3 },
] as const;
export const syntheticCapacityWorkloads: readonly CapacityWorkload[] = [
  { id: "2-images", printings: 2, images: 2, imageBytes: 2 * 100 * 1024, structuredBytes: 16 * 1024 },
  { id: "128-images", printings: 128, images: 128, imageBytes: 128 * 100 * 1024, structuredBytes: 1024 ** 2 },
  ...syntheticCapacityTiers,
];
export const capacityPrintingsPerPage = 16;
export const capacityImageChunkBytes = 65536;
export const capacityMaximumPageBytes = 2 * 1024 ** 2;

export function syntheticCapacityTier(id: string): CapacityWorkload {
  const workload = syntheticCapacityWorkloads.find((tier) => tier.id === id);
  if (!workload) throw new Error(`Unknown synthetic capacity tier: ${id}`);
  return workload;
}

export function capacityByteShare(total: number, count: number, index: number) {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(count) || count < 1)
    throw new Error("Capacity byte census must use non-negative safe integers and a positive count");
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("Capacity index out of range");
  return Math.floor(total / count) + Number(index < total % count);
}

export function capacityPageCount(workload: CapacityWorkload, printingsPerPage = capacityPrintingsPerPage) {
  if (!Number.isSafeInteger(printingsPerPage) || printingsPerPage < 1 || printingsPerPage > 128)
    throw new Error("Capacity pages must contain 1 to 128 Printings");
  if (
    !Number.isSafeInteger(workload.printings) ||
    workload.printings < 1 ||
    !Number.isSafeInteger(workload.images) ||
    workload.images < workload.printings ||
    workload.images % workload.printings !== 0 ||
    workload.images / workload.printings > 3
  )
    throw new Error("Capacity workload requires 1 to 3 image roles per Printing");
  return Math.ceil(workload.printings / printingsPerPage);
}

export function capacityPageUrl(tier: string, page: number) {
  const workload = syntheticCapacityTier(tier);
  checkPage(workload, page, capacityPrintingsPerPage);
  return `https://official-source.invalid/reconciliation/capacity-${tier}-page-${page}`;
}

function checkPage(workload: CapacityWorkload, page: number, printingsPerPage: number) {
  const pages = capacityPageCount(workload, printingsPerPage);
  if (!Number.isSafeInteger(page) || page < 0 || page >= pages) throw new Error("Capacity page out of range");
  const bytes = capacityByteShare(workload.structuredBytes, pages, page);
  if (bytes > capacityMaximumPageBytes) throw new Error("Capacity page exceeds its bounded structured byte budget");
  return bytes;
}

export function capacityPageDocument(
  workload: CapacityWorkload,
  page: number,
  printingsPerPage = capacityPrintingsPerPage,
) {
  const bytes = checkPage(workload, page, printingsPerPage);
  const first = page * printingsPerPage;
  const imageRoles = ["front", "back", "other"] as const;
  const imagesPerPrinting = workload.images / workload.printings;
  const cards = Array.from({ length: Math.min(printingsPerPage, workload.printings - first) }, (_, offset) => {
    const index = first + offset;
    const artworkFingerprint = `sha256:${(index + 1).toString(16).padStart(64, "0")}`;
    const images = Array.from({ length: imagesPerPrinting }, (_, face) => ({
      role: imageRoles[face]!,
      source_url: `https://official-source.invalid/images/capacity-${workload.id}-${index * imagesPerPrinting + face}.png`,
      artwork_fingerprint: artworkFingerprint,
    }));
    return {
      card: {
        game: "one-piece",
        official_identity: { kind: "card_number", value: `SYN-${String(index + 1).padStart(6, "0")}` },
        name: `Synthetic capacity Card ${index + 1}`,
        effective_rules_text: "Synthetic fixture rules.",
        game_data: {
          profile: "one-piece@1",
          attributes: {
            card_type: "leader",
            colours: ["red"],
            cost: null,
            life: 5,
            battle_attributes: ["strike"],
            power: 5000,
            counter: null,
            traits: ["Synthetic"],
            block_icons: ["1"],
            effect_text: "Synthetic fixture rules.",
            trigger_text: null,
          },
        },
      },
      printing: {
        rarity: { raw: "L", normalized: "leader" },
        printed_rules_text: "Synthetic fixture rules.",
        game_data: { profile: "one-piece@1", attributes: { illustration_types: [] } },
      },
      identity_evidence: {
        locator: `capacity-${workload.id}-${index}`,
        artwork_fingerprint: artworkFingerprint,
        printed_fields_digest: `sha256:${"b".repeat(64)}`,
        treatment: "standard",
        demonstrably_novel: true,
        novelty_basis: {
          kind: "official_printing_image",
          source_url: images[0]!.source_url,
          artwork_fingerprint: artworkFingerprint,
        },
      },
      appearance_evidence: { images },
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: 1,
        parsed_record_count: 1,
      },
      memberships: { products: [], distribution_contexts: [], source_buckets: ["capacity"] },
    };
  });
  const document = { cards };
  const padding = bytes - Buffer.byteLength(JSON.stringify(document));
  if (padding < 0) throw new Error("Capacity fixture metadata exceeds its accepted byte census");
  // Spread accepted structured bytes across records; do not turn the page's
  // padding into one artificially oversized card field.
  for (const [index, card] of cards.entries())
    card.card.effective_rules_text += "x".repeat(capacityByteShare(padding, cards.length, index));
  return document;
}

// A valid 1x1 RGBA PNG, with deterministic incompressible ancillary bytes before
// IEND. These are synthetic transfer/storage bytes, not representative artwork
// entropy, dimensions, visual complexity, or image-decoder CPU measurements.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const ancillaryType = new TextEncoder().encode("caPy");
function crcStep(crc: number, bytes: Uint8Array) {
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc;
}
function uint32(value: number) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value);
  return result;
}

export function capacityImageResponse(workload: CapacityWorkload, index: number): Response {
  capacityPageCount(workload);
  const size = capacityByteShare(workload.imageBytes, workload.images, index);
  const padding = size - png.length - 12;
  if (padding < 4 || padding > 0x7fffffff) throw new Error("Capacity image byte budget cannot encode its PNG");
  let state = index + 1;
  let remaining = padding;
  let crc = crcStep(0xffffffff, ancillaryType);
  let phase = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (phase === 0) {
            const prefix = new Uint8Array(png.length - 12 + 8);
            prefix.set(png.subarray(0, -12));
            prefix.set(uint32(padding), png.length - 12);
            prefix.set(ancillaryType, png.length - 8);
            controller.enqueue(prefix);
            phase++;
          } else if (remaining > 0) {
            const chunk = new Uint8Array(Math.min(remaining, capacityImageChunkBytes));
            for (let offset = 0; offset < chunk.length; offset++) {
              state ^= state << 13;
              state ^= state >>> 17;
              state ^= state << 5;
              chunk[offset] = state & 255;
            }
            crc = crcStep(crc, chunk);
            remaining -= chunk.length;
            controller.enqueue(chunk);
          } else {
            const suffix = new Uint8Array(16);
            suffix.set(uint32((crc ^ 0xffffffff) >>> 0));
            suffix.set(png.subarray(-12), 4);
            controller.enqueue(suffix);
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    ),
    {
      headers: {
        "content-type": "image/png",
        "content-length": String(size),
        etag: `"capacity-${workload.id}-${index}-${size}"`,
      },
    },
  );
}

export function capacitySourceResponse(url: URL): Response | null {
  const page = /^\/reconciliation\/capacity-(tier-[12]|2-images|128-images)-page-([0-9]+)$/u.exec(url.pathname);
  const image = /^\/images\/capacity-(tier-[12]|2-images|128-images)-([0-9]+)\.png$/u.exec(url.pathname);
  if (page === null && image === null) return null;
  try {
    if (page) return Response.json(capacityPageDocument(syntheticCapacityTier(page[1]!), Number(page[2])));
    return capacityImageResponse(syntheticCapacityTier(image![1]!), Number(image![2]));
  } catch {
    return new Response("Capacity fixture request outside declared census", { status: 404 });
  }
}
