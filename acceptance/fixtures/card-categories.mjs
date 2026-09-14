import { createHash } from "node:crypto";

// Synthetic, bounded model proof; this is not evidence of a publisher's inventory.
export function cardCategorySource() {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const artwork = `sha256:${"a".repeat(64)}`;
  const attributes = {
    card_types: ["unit"], supertypes: [], domains: ["fury"], energy: 2,
    power: null, might: 3, might_bonus: null, tags: [], ability_text: null, effect_text: null,
  };
  return { cards: [
    ["gameplay", "ordinary"], ["art", "ordinary"], ["art", "stamped"], ["art", "foil"], ["token", "ordinary"],
  ].map(([category, treatment]) => {
    const locator = `${category}-${treatment}`;
    const imageUrl = `https://category-source.invalid/images/${locator}.png`;
    return {
      card: {
        game: "riftbound", category,
        gameplay_applicability: category === "art" ? "inapplicable" : "applicable",
        official_identity: { kind: "publisher_name", value: category === "token" ? "Companion" : "Shared illustration" },
        name: category === "token" ? "Companion" : "Shared illustration",
        effective_rules_text: null,
        game_data: { profile: "riftbound@1", attributes: category === "art" ? {} : { ...attributes, supertypes: category === "token" ? ["token"] : [] } },
      },
      printing: {
        rarity: { raw: null, normalized: null }, printed_rules_text: null,
        game_data: { profile: "riftbound@1", attributes: {
          public_code: null, collector_number: null, set_code: "PILOT", orientation: null,
          reverse_face: null, finish: treatment, artists: [],
        } },
      },
      card_relationships: category === "art" && treatment === "ordinary" ? [{
        kind: "shared_artwork", target: { source_lineage: "riftbound-en", locator: "gameplay-ordinary", variant_key: "ordinary" },
      }] : [],
      identity_evidence: {
        locator, variant_key: treatment, artwork_fingerprint: artwork,
        printed_fields_digest: `sha256:${"b".repeat(64)}`, treatment,
        demonstrably_novel: true,
        novelty_basis: { kind: "official_printing_image", source_url: imageUrl, artwork_fingerprint: artwork },
      },
      appearance_evidence: { images: [{ role: "front", source_url: imageUrl, artwork_fingerprint: artwork,
        media_type: "image/png", width: 1, height: 1,
        content_sha256: createHash("sha256").update(bytes).digest("hex"), content_base64: bytes.toString("base64"),
      }] },
      completeness: { structurally_complete: true, required_surfaces_complete: true, partitions_complete: true, declared_record_count: 1, parsed_record_count: 1 },
      memberships: { products: [], distribution_contexts: [], source_buckets: ["category-pilot"] },
    };
  }) };
}
