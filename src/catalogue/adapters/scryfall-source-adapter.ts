import { createHash } from "node:crypto";
import type { SourceAdapterRegistration, SourcePrintingIdentityEvidence } from "./source-adapter-registration-types";
import { AdapterParseFailure, adapterUrl, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";

const lineage = "scryfall-magic-en";
const api = "https://api.scryfall.com";
const userAgent = "Card-Keepr/0.1 (+https://github.com/KeeprDigital/card-keepr)";
const selectedRecords = [
  "6904ea20-e504-47da-95a0-08739fdde260",
  "8de2ff37-fdb7-4f77-9d48-e99afac9a79e",
  "7f57005c-414d-4c83-9b4f-cd26e547d54d",
  "a33fda72-e61d-478f-bc33-ff1a23b5f45b",
] as const;
const sharedIllustration = "6212644b-1700-4f2d-bbe3-d51bc45875e6";
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const mappedFields = new Set([
  "object",
  "id",
  "oracle_id",
  "uri",
  "name",
  "lang",
  "games",
  "digital",
  "released_at",
  "layout",
  "set",
  "set_type",
  "type_line",
  "card_faces",
  "finishes",
  "foil",
  "nonfoil",
  "image_uris",
  "illustration_id",
  "color_identity",
  "colors",
  "mana_cost",
  "oracle_text",
  "power",
  "toughness",
  "artist",
  "artist_id",
  "printed_text",
  "collector_number",
  "rarity",
  "frame",
  "border_color",
  "full_art",
  "textless",
]);
// These remain verbatim in the Source Snapshot, but are deliberately outside
// this pilot's normalized catalogue facts and discovery graph.
const faceFields = new Set([
  "object",
  "id",
  "oracle_id",
  "name",
  "mana_cost",
  "type_line",
  "oracle_text",
  "colors",
  "power",
  "toughness",
  "flavor_text",
  "artist",
  "artist_id",
  "illustration_id",
  "image_uris",
  "printed_text",
]);
const outsideScopeFields = new Set([
  "arena_id",
  "mtgo_id",
  "mtgo_foil_id",
  "multiverse_ids",
  "tcgplayer_id",
  "tcgplayer_etched_id",
  "cardmarket_id",
  "legalities",
  "prices",
  "purchase_uris",
  "related_uris",
  "rulings_uri",
  "edhrec_rank",
  "penny_rank",
  "scryfall_uri",
  "prints_search_uri",
  "set_uri",
  "set_search_uri",
  "scryfall_set_uri",
  "set_id",
  "set_name",
  "all_parts",
  "cmc",
  "keywords",
  "reserved",
  "reprint",
  "promo",
  "variation",
  "booster",
  "story_spotlight",
  "highres_image",
  "image_status",
  "card_back_id",
  "flavor_text",
]);
const surfaceUrl = (surface: string) => {
  if (!selectedRecords.some((id) => id === surface))
    throw new AdapterParseFailure("Unknown Scryfall pilot record surface.", { category: "configuration" });
  return `${api}/cards/${surface}`;
};
const coverage = {
  description:
    "Four selected issued English paper records and their declared finishes/faces. No complete Magic inventory, regional Release, pricing, legality or ruling claim.",
  requiredSurfaces: selectedRecords,
  requestUrlForSurface: surfaceUrl,
};

export const scryfallSourceAdapterRegistration: SourceAdapterRegistration = {
  adapterVersion: "scryfall-magic-en@1",
  sourceLineage: lineage,
  supportedGame: "magic",
  gameProfileVersion: "magic@1",
  parserContract: "scryfall-magic-card-pilot@1",
  maximumSnapshotBytes: 2 * 1024 * 1024,
  requestCapacity: 10,
  minimumRateLimitBackoffMilliseconds: 30_000,
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "source_qualification",
  qualifiesCardDesignIdentity: qualifiesDesign,
  qualifiesPrintingIdentity(evidence) {
    const attributes = evidence.observedCardAndPrinting.printing?.game_data?.attributes;
    return (
      qualifiesDesign(evidence) &&
      evidence.observedCardAndPrinting.printing?.game_data?.profile === "magic@1" &&
      ["nonfoil", "foil"].includes(evidence.variantKey ?? "") &&
      attributes?.finish === evidence.variantKey &&
      typeof attributes.set_code === "string" &&
      typeof attributes.collector_number === "string" &&
      evidence.artworkFingerprint?.startsWith("scryfall:illustration:") === true
    );
  },
  reconciliationAreas: ["catalogue"],
  requiredSurfaces: coverage.requiredSurfaces,
  requestUrlForSurface: surfaceUrl,
  coverageContracts: { "representative-english-paper": coverage },
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    return parseRecord(bytes, context.url).observations;
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    return parseRecord(bytes, context.url).images.map((image) => ({
      role: "image",
      url: image.source_url,
      headers: { accept: "image/jpeg", "user-agent": userAgent },
    }));
  },
};

function qualifiesDesign(evidence: SourcePrintingIdentityEvidence) {
  return (
    evidence.observedCardAndPrinting.card?.game === "magic" &&
    evidence.observedCardAndPrinting.card.official_identity.kind === "unknown" &&
    typeof evidence.cardDesignKey === "string" &&
    evidence.cardDesignKey.startsWith("oracle:") &&
    uuidPattern.test(evidence.cardDesignKey.slice("oracle:".length)) &&
    selectedRecords.some((id) => id === evidence.locator)
  );
}

function parseRecord(bytes: Uint8Array, sourceUrl: string) {
  const card = object(withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes))));
  const id = uuid(card.id);
  if (sourceUrl !== surfaceUrl(id) || card.uri !== sourceUrl || card.object !== "card")
    throw new AdapterParseFailure("Scryfall response does not match its exact selected record.");
  if (card.lang !== "en" || card.digital !== false || !list(card.games).includes("paper"))
    throw new AdapterParseFailure("Scryfall pilot requires explicit English physical availability.");
  // The pilot's issue evidence predates this cutoff. Never use parser wall time
  // to silently turn a preview into an issued Printing on replay.
  if (
    typeof card.released_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(card.released_at) ||
    card.released_at > "2026-09-14"
  )
    throw new AdapterParseFailure("Scryfall pilot requires retained issued-card release evidence.");
  const releaseTime = Date.parse(`${card.released_at}T00:00:00.000Z`);
  if (!Number.isFinite(releaseTime) || new Date(releaseTime).toISOString().slice(0, 10) !== card.released_at)
    throw new AdapterParseFailure("Scryfall issued-card release date is invalid.");
  const oracle = uuid(card.oracle_id);
  const layout = text(card.layout);
  if (!["normal", "transform", "art_series", "token"].includes(layout))
    throw new AdapterParseFailure("Scryfall layout has no qualified pilot mapping.");
  const art = layout === "art_series";
  const token = layout === "token";
  const category = art ? "art" : token ? "token" : "gameplay";
  if (
    (token && (card.set_type !== "token" || !text(card.type_line).startsWith("Token "))) ||
    (art && (card.set_type !== "memorabilia" || card.type_line !== "Card // Card"))
  )
    throw new AdapterParseFailure("Scryfall Card category evidence is contradictory.");
  const faces = card.card_faces === undefined ? [card] : list(card.card_faces).map(object);
  if (faces.length !== (layout === "transform" || art ? 2 : 1))
    throw new AdapterParseFailure("Scryfall layout and physical faces disagree.");
  const finishes = list(card.finishes).map(text);
  if (
    !finishes.length ||
    new Set(finishes).size !== finishes.length ||
    finishes.some((finish) => !["nonfoil", "foil"].includes(finish)) ||
    card.foil !== finishes.includes("foil") ||
    card.nonfoil !== finishes.includes("nonfoil")
  )
    throw new AdapterParseFailure("Scryfall finish availability is incomplete or contradictory.");
  const fingerprint = `scryfall:illustration:${uuid(faces[0]!.illustration_id)}`;
  const images = faces.map((face, index) => {
    const role = index === 0 ? "front" : "back";
    const url = adapterUrl(text(object(face.image_uris).normal));
    if (
      url.origin !== "https://cards.scryfall.io" ||
      url.pathname !== `/normal/${role}/${id[0]}/${id[1]}/${id}.jpg` ||
      !/^\?\d+$/u.test(url.search) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new AdapterParseFailure("Scryfall whole-card image is outside the returned record/face authority.");
    return { role, source_url: url.href, artwork_fingerprint: fingerprint };
  });
  const cardAttributes = art
    ? {}
    : {
        layout,
        type_line: text(card.type_line),
        colour_identity: list(card.color_identity).map(text),
        faces: faces.map((face, index) => ({
          role: index === 0 ? "front" : "back",
          name: text(face.name),
          mana_cost: optionalText(face.mana_cost),
          type_line: text(face.type_line),
          colours: list(face.colors).map(text),
          oracle_text: optionalText(face.oracle_text),
          power: optionalText(face.power),
          toughness: optionalText(face.toughness),
        })),
      };
  const printedFaces = faces.map((face, index) => ({
    role: index === 0 ? "front" : "back",
    name: text(face.name),
    printed_rules_text: art ? null : optionalText(face.printed_text),
  }));
  const observations = finishes.map((finish) => {
    const attributes = {
      set_code: text(card.set),
      collector_number: text(card.collector_number),
      finish,
      layout,
      faces: printedFaces,
      artists: [...new Set(faces.map((face) => text(face.artist)))],
      reverse_face: faces.length === 2 ? text(faces[1]!.name) : null,
      // The record supplies one scan set shared by its finishes, not a scan of
      // each physical finish. Retain that limitation even when bytes are present.
      finish_image: null,
    };
    return {
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: finishes.length,
        parsed_record_count: finishes.length,
      },
      card: {
        game: "magic",
        category,
        gameplay_applicability: art ? "inapplicable" : "applicable",
        official_identity: { kind: "unknown", value: null },
        name: text(card.name),
        effective_rules_text: art
          ? null
          : faces
              .map((face) => optionalText(face.oracle_text))
              .filter(Boolean)
              .join("\n") || null,
        game_data: { profile: "magic@1", attributes: cardAttributes },
      },
      card_identity_evidence: { source_design_key: `oracle:${oracle}` },
      printing: {
        rarity: { raw: text(card.rarity), normalized: text(card.rarity) },
        printed_rules_text:
          art || printedFaces.some((face) => face.printed_rules_text === null)
            ? null
            : printedFaces.map((face) => face.printed_rules_text).join("\n"),
        game_data: { profile: "magic@1", attributes },
      },
      // This bounded association names one gameplay Printing only. Reconciliation
      // must verify the target's actual retained illustration before publishing it.
      card_relationships:
        id === selectedRecords[1] && finish === "nonfoil" && faces[0]!.illustration_id === sharedIllustration
          ? [
              {
                kind: "shared_artwork",
                target: { source_lineage: lineage, locator: selectedRecords[2], variant_key: "nonfoil" },
              },
            ]
          : [],
      identity_evidence: {
        locator: id,
        variant_key: finish,
        artwork_fingerprint: fingerprint,
        printed_fields_digest: createHash("sha256")
          .update(
            JSON.stringify({
              ...attributes,
              illustrations: faces.map((face) => uuid(face.illustration_id)),
              frame: card.frame,
              border_color: card.border_color,
              full_art: card.full_art,
              textless: card.textless,
            }),
          )
          .digest("hex"),
        treatment: finish,
        demonstrably_novel: card.image_status === "highres_scan",
        novelty_basis: {
          kind: "source_printing_image",
          source_url: images[0]!.source_url,
          artwork_fingerprint: fingerprint,
        },
      },
      appearance_evidence: { images },
      memberships: { products: [], distribution_contexts: [], source_buckets: [text(card.set)] },
      source_sidecar: {
        source_record_json: JSON.stringify(card),
        unmapped_optional_fields: [
          ...Object.entries(card)
            .filter(([field]) => !mappedFields.has(field) && !outsideScopeFields.has(field))
            .map(([field, value]) => ({ path: `source_record.${field}`, value: JSON.stringify(value) })),
          ...faces.flatMap((face, index) =>
            face === card
              ? []
              : Object.entries(face)
                  .filter(([field]) => !faceFields.has(field))
                  .map(([field, value]) => ({
                    path: `source_record.card_faces.${index}.${field}`,
                    value: JSON.stringify(value),
                  })),
          ),
        ],
        face_identifiers: faces.map((face, index) => ({
          parent_record_id: id,
          role: index === 0 ? "front" : "back",
          id: face === card ? null : (face.id ?? null),
          oracle_id: face === card ? null : (face.oracle_id ?? null),
          illustration_id: uuid(face.illustration_id),
        })),
      },
    };
  });
  return { observations, images };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("Scryfall required object is missing.");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new AdapterParseFailure("Scryfall required list is missing.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new AdapterParseFailure("Scryfall required text is missing.");
  return value;
}
function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AdapterParseFailure("Scryfall optional text is invalid.");
  return value;
}
function uuid(value: unknown) {
  const id = text(value);
  if (!uuidPattern.test(id)) throw new AdapterParseFailure("Scryfall source identifier is invalid.");
  return id;
}
