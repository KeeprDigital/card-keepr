import { type CatalogueStore, consumerContent } from "../shared";
import { printingImageMetadataStatement, retainedPrintingCardStatement } from "./published-read-repository";

/** The retained aggregate projection uses the same consumer image metadata as native reads. */
export async function retainedPrintingRepresentation(database: CatalogueStore, revision: string, input: unknown) {
  const value = consumerContent(input) as Record<string, unknown>;
  const parent = await retainedPrintingCardStatement(database, revision, String(value.card_id)).first<{
    document_json: string;
  }>();
  if (!parent) throw new Error("The published Printing Card is unavailable.");
  const card = JSON.parse(parent.document_json) as Record<string, unknown>;
  const images = value.printing_images as Record<string, unknown>[];
  const metadata = (
    await printingImageMetadataStatement(database, revision, String(value.id)).all<{
      image_id: string;
      content_byte_length: number;
    }>()
  ).results;
  return {
    ...value,
    category: ((card.data ?? card) as Record<string, unknown>).category,
    printing_images: images.map((image) => ({
      id: image.id,
      role: image.role,
      media_type: image.media_type,
      width: image.width,
      height: image.height,
      content_sha256: image.content_sha256,
      content_byte_length: metadata.find(({ image_id }) => image_id === image.id)?.content_byte_length,
      links: { content: (image.links as Record<string, unknown>).content },
    })),
  };
}
