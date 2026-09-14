import { AdapterParseFailure, decodeAdapterUtf8 } from "./adapter-parse-failure";
import { htmlText, requiredHtmlMatch } from "./adapter-html";
import { createHash } from "node:crypto";
import { officialArtworkFingerprint } from "./official-artwork-identity";
import type { SourceAdapterRegistration } from "./source-adapter-registration-types";

export const pokemonSnorlaxProductUrl =
  "https://www.pokemon.com/us/pokemon-tcg/product-gallery/scarlet-violet-151-pokemon-center-elite-trainer-box";
export const pokemonGarchompCardUrl = "https://www.pokemon.com/us/pokemon-tcg/pokemon-cards/series/swsh9/109";
export const pokemonGarchompErratumUrl =
  "https://www.pokemon.com/us/news/errata-for-garchomp-in-pokemon-tcg-sword-shield-brilliant-stars";

const garchompImage =
  "https://assets.pokemon.com/static-assets/content-assets/cms2/img/cards/web/SWSH9/SWSH9_EN_109.png";
const garchompIdentity = "BRILLIANT-STARS-109/172";

export function pokemonOfficialErratum(bytes: Uint8Array) {
  const html = decodeAdapterUtf8(bytes);
  const article = requiredHtmlMatch(html, /<article>([\s\S]*?)<\/article>/u, "Pokémon correction article")[1]!;
  const date = requiredHtmlMatch(html, /<time dateTime="([^"]+)">/u, "Pokémon correction publication date")[1]!;
  const wording = htmlText(article.replace(/<\/?(?:span|em)\b[^>]*>/gu, ""));
  const quoted = [...article.matchAll(/<p style="color: black;[^>]*>([^<]+)<\/p>/gu)].map((match) =>
    htmlText(match[1]!),
  );
  if (
    date !== "Feb 9, 2022" ||
    quoted.length !== 2 ||
    !wording.includes("Garchomp (Sword & Shield—Brilliant Stars, 109/172)") ||
    !wording.includes("Effective immediately, Garchomp’s Sonic Slip Ability") ||
    !quoted[0]!.includes("effects of attacks done") ||
    !quoted[1]!.includes("effects of attacks from your opponent’s Pokémon done")
  )
    throw new AdapterParseFailure("The selected dated Pokémon correction target or old/new wording changed.");
  return {
    kind: "official_erratum",
    game: "pokemon",
    target: { type: "card", official_identity: { kind: "card_number", value: garchompIdentity } },
    published_on: "2022-02-09",
    effective_from: "2022-02-09",
    observed_printed_rules_text: quoted[0]!,
    corrected_rules_text: quoted[1]!,
    official_wording: wording,
    applies_to_parallel_printings: true,
    source: {
      kind: "article_heading",
      url: pokemonGarchompErratumUrl,
      heading: "Garchomp — Sonic Slip — Brilliant Stars 109/172",
    },
    completeness: complete(),
  };
}

export function pokemonOfficialGarchomp(bytes: Uint8Array) {
  const document = decodeAdapterUtf8(bytes);
  const html = requiredHtmlMatch(
    document,
    /<section class="mosaic section card-detail">([\s\S]*?)<\/section>/u,
    "Pokémon selected card section",
  )[1]!;
  const field = (pattern: RegExp, label: string) => htmlText(requiredHtmlMatch(html, pattern, `Pokémon ${label}`)[1]!);
  const pageId = field(/data-card-id='([^']+)'/u, "card locator");
  const name = field(/<h1>([^<]+)<\/h1>/u, "card name");
  const set = field(/<div class="stats-footer">\s*<h3>\s*<a[^>]*>([^<]+)<\/a>/u, "set name");
  const numberAndRarity = field(/<span>(109\/172 [^<]+)<\/span>/u, "collector number and rarity");
  if (
    pageId !== "swsh9/109" ||
    name !== "Garchomp" ||
    set !== "Brilliant Stars" ||
    numberAndRarity !== "109/172 Rare Holo"
  )
    throw new AdapterParseFailure("The selected official Garchomp identity changed.");
  const ability = field(/<div>Sonic Slip<\/div>\s*<\/h3>\s*<p>([\s\S]*?)<\/p>/u, "Sonic Slip text");
  const attack = field(/<pre>([\s\S]*?)<\/pre>/u, "Dragonblade text");
  const attackName = field(/<h4 class="left label">([^<]+)<\/h4>/u, "attack name");
  if (
    attackName !== "Dragonblade" ||
    [...html.matchAll(/<div class="ability">/gu)].length !== 2 ||
    field(/<h4>Weakness<\/h4>([\s\S]*?)<\/div>/u, "weakness") !== "" ||
    field(/<h4>Resistance<\/h4>([\s\S]*?)<\/div>/u, "resistance") !== ""
  )
    throw new AdapterParseFailure("The selected original Garchomp abilities, weakness or resistance changed.");
  const stage = field(/<h2>([^<]+)<\/h2>/u, "stage");
  if (stage !== "Stage 2 Pokémon") throw new AdapterParseFailure("The selected official Garchomp stage changed.");
  const attributes = {
    card_type: "pokemon",
    hp: Number(field(/<span class="card-hp"><span>HP<\/span>(\d+)<\/span>/u, "HP")),
    types: [field(/<a href="[^"]*\?card-dragon=on"><i[^>]*title="([^"]+)"/u, "type")],
    stage: "Stage2",
    evolves_from: field(/<h4>Evolves From:\s*<a[^>]*>([^<]+)<\/a>/u, "evolution"),
    abilities: [{ kind: "Ability", name: "Sonic Slip", text: ability }],
    attacks: [
      {
        name: attackName,
        cost: [...html.matchAll(/data-energy-type="([^"]+)"/gu)].map((match) => match[1]!),
        damage: field(/<span class="right plus">([^<]+)<\/span>/u, "attack damage"),
        text: attack,
      },
    ],
    weaknesses: [],
    resistances: [],
    retreat_cost: Number(field(/retreatCostMin=(\d+)&retreatCostMax=\d+/u, "retreat cost")),
    regulation_mark: null,
  };
  const printingAttributes = {
    set_code: "BRILLIANT-STARS",
    collector_number: "109/172",
    finish: "holo",
    edition: null,
    size: null,
    stamps: [],
    artists: [field(/particularArtist=[^"]+">([^<]+)<\/a>/u, "illustrator")],
    reverse_face: null,
  };
  // The dated correction and hash-pinned image establish the original issued
  // wording. A changed card page needs fresh qualification, not a new Printing.
  if (
    ability !==
      "When you play this Pokémon from your hand to evolve 1 of your Pokémon during your turn, you may prevent all damage from and effects of attacks done to this Pokémon until the end of your opponent’s next turn." ||
    attack !== "Discard the top 2 cards of your deck."
  )
    throw new AdapterParseFailure("The selected original Garchomp printed wording changed.");
  const rules = `Sonic Slip: ${ability}\nDragonblade: ${attack}`;
  const fingerprint = officialArtworkFingerprint(garchompIdentity, ["front"], "original-sonic-slip");
  const image = field(/<img src="([^"]+)"/u, "card image");
  if (image !== garchompImage) throw new AdapterParseFailure("The selected official Garchomp image surface changed.");
  return {
    completeness: complete(),
    card: {
      game: "pokemon",
      category: "gameplay",
      official_identity: { kind: "card_number", value: garchompIdentity },
      name,
      effective_rules_text: rules,
      game_data: { profile: "pokemon@1", attributes },
    },
    printing: {
      rarity: { raw: "Rare Holo", normalized: null },
      printed_rules_text: rules,
      game_data: { profile: "pokemon@1", attributes: printingAttributes },
    },
    identity_evidence: {
      locator: pageId,
      variant_key: "original-sonic-slip",
      artwork_fingerprint: fingerprint,
      printed_fields_digest: createHash("sha256").update(JSON.stringify(printingAttributes)).digest("hex"),
      treatment: "holo-original-sonic-slip",
    },
    appearance_evidence: {
      images: [
        {
          role: "front",
          source_url: image,
          artwork_fingerprint: fingerprint,
          content_sha256: "179a4492bf725961091125a452fbf5127a733f4768e99f8205265fc80302eb90",
        },
      ],
    },
    memberships: { products: [], distribution_contexts: [], source_buckets: [set] },
    product_release_catalogue: { products: [], distribution_contexts: [], relationships: [] },
    source_sidecar: {
      publisher_identity: { set, collector_number: "109/172", page_card_id: pageId },
      original_card_text: rules,
      publication_url: pokemonGarchompCardUrl,
      unmapped_optional_fields: [],
    },
  };
}

function complete(count = 1) {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: count,
    parsed_record_count: count,
  };
}

export function pokemonOfficialProduct(bytes: Uint8Array) {
  const html = decodeAdapterUtf8(bytes);
  const name = htmlText(
    requiredHtmlMatch(html, /<h1 class="us-title"\s*>([\s\S]*?)<\/h1>/u, "Pokémon Product title")[1]!,
  );
  if (name !== "Pokémon TCG: Scarlet & Violet—151 Pokémon Center Elite Trainer Box")
    throw new AdapterParseFailure("The selected Pokémon Product title changed.");
  const launch = htmlText(requiredHtmlMatch(html, /Launch:\s*([^<]+)/u, "Pokémon Product launch date")[1]!);
  const promoContents = [...html.matchAll(/<li>\s*<p>([^<]*Snorlax[^<]*)<\/p>\s*<\/li>/gu)].map((match) =>
    htmlText(match[1]!),
  );
  if (
    launch !== "September 22, 2023" ||
    promoContents.length !== 2 ||
    !promoContents[0]!.includes("with a Pokémon Center logo") ||
    !promoContents[1]!.endsWith("featuring Snorlax")
  )
    throw new AdapterParseFailure("The selected Pokémon Product's dated two-promo evidence changed.");
  return {
    completeness: complete(),
    product_release_catalogue: {
      products: [
        {
          reference: { kind: "name", value: name },
          official_code: null,
          name,
          releases: [
            {
              event_key: "announced-english-launch",
              region: "unknown",
              date: { precision: "day", value: "2023-09-22" },
              status: "announced",
            },
          ],
        },
      ],
      distribution_contexts: [],
      // The text names treatments, but supplies no collector number or exact
      // face link. Keep that corroboration without inventing a membership join.
      relationships: [],
    },
    source_sidecar: {
      publication_url: pokemonSnorlaxProductUrl,
      promo_contents: promoContents,
      unmapped_optional_fields: [],
    },
  };
}

const surfaces: Readonly<Record<string, string>> = {
  "snorlax-product": pokemonSnorlaxProductUrl,
  "garchomp-card": pokemonGarchompCardUrl,
  errata: pokemonGarchompErratumUrl,
};
function surfaceUrl(surface: string) {
  const url = surfaces[surface];
  if (url === undefined)
    throw new AdapterParseFailure("Unknown selected Pokémon publication.", { category: "configuration" });
  return url;
}

export const pokemonOfficialSourceAdapterRegistration = {
  adapterVersion: "pokemon-official-en@1",
  sourceLineage: "pokemon-official-en",
  supportedGame: "pokemon",
  gameProfileVersion: "pokemon@1",
  parserContract: "pokemon-selected-publications-html@1",
  maximumSnapshotBytes: 1024 * 1024,
  requestCapacity: 4,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "owner_review",
  reconciliationAreas: ["catalogue", "errata"],
  requiredSurfaces: Object.keys(surfaces),
  requestUrlForSurface: surfaceUrl,
  coverageContracts: {
    "card-product-correction-pilot": {
      description: "The selected Garchomp Card, 151 Product and dated Sonic Slip correction publications together.",
      reconciliationAreas: ["catalogue", "errata"],
      requiredSurfaces: Object.keys(surfaces),
      requestUrlForSurface: surfaceUrl,
    },
    "card-product-pilot": {
      description:
        "Exactly Garchomp Brilliant Stars 109/172 and the 151 Pokémon Center Elite Trainer Box publication. No global unique-coverage claim.",
      reconciliationAreas: ["catalogue"],
      requiredSurfaces: ["snorlax-product", "garchomp-card"],
      requestUrlForSurface: surfaceUrl,
    },
    "garchomp-correction": {
      description: "Exactly the 9 February 2022 Garchomp Brilliant Stars 109/172 Sonic Slip correction.",
      reconciliationAreas: ["errata"],
      reconciliationCapability: "errata",
      requiredSurfaces: ["errata"],
      requestUrlForSurface: surfaceUrl,
    },
  },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (context.url === pokemonSnorlaxProductUrl) return [pokemonOfficialProduct(bytes)];
    if (context.url === pokemonGarchompCardUrl) return [pokemonOfficialGarchomp(bytes)];
    if (context.url === pokemonGarchompErratumUrl) return [pokemonOfficialErratum(bytes)];
    throw new AdapterParseFailure("Pokémon document is outside the exact selected publication scope.");
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (context.url === pokemonGarchompCardUrl) {
      pokemonOfficialGarchomp(bytes);
      return [{ role: "image" as const, url: garchompImage, headers: { accept: "image/png" } }];
    }
    if (context.url === pokemonSnorlaxProductUrl) pokemonOfficialProduct(bytes);
    else if (context.url === pokemonGarchompErratumUrl) pokemonOfficialErratum(bytes);
    else throw new AdapterParseFailure("Pokémon document is outside the exact selected publication scope.");
    return [];
  },
} satisfies SourceAdapterRegistration;
