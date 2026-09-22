import { createHash } from "node:crypto";
import { magicFaceRoles, magicLayouts } from "../shared";
import type { ScryfallSourceAdmissionEvidenceObservation } from "./adapter-observations";
import {
  scryfallArchiveLimits,
  scryfallBulkMetadataUrl,
  scryfallBulkPin,
  scryfallCapturedBulkPin,
} from "./scryfall-bulk";
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
  if (!uuidPattern.test(surface))
    throw new AdapterParseFailure("Invalid Scryfall record surface.", { category: "configuration" });
  return `${api}/cards/${surface}`;
};
const coverage = {
  description:
    "Four selected issued English paper records and their declared finishes/faces. No complete Magic inventory, regional Release, pricing, legality or ruling claim.",
  requiredSurfaces: selectedRecords,
  requestUrlForSurface: surfaceUrl,
};
const bulkSurfaceUrl = (surface: string) => {
  if (surface !== "bulk-data")
    throw new AdapterParseFailure("Invalid Scryfall bulk metadata surface.", { category: "configuration" });
  return scryfallBulkMetadataUrl;
};
// Owner decision (#327, 2026-09-21): images arrive progressively. Tranche 0
// reads the complete pinned inventory and acquires no image: its image URLs
// remain appearance claims, so every Printing keeps an explicit image gap.
// Later tranches are ordinary complete runs whose images the run's
// Acquisition Budget meters. As a named scope it never infers disappearance.
const factsOnly = {
  description:
    "Every declared English paper Printing fact from the pinned bulk inventory, acquiring no Printing Images (tranche 0).",
  requiredSurfaces: ["bulk-data"],
  requestUrlForSurface: bulkSurfaceUrl,
  acquiredDiscoveryRoles: ["listing"],
} as const;
// Owner decision (#327, 2026-09-22): image tranches of 5k-10k original normal
// JPEGs (the only image form this adapter discovers), newest sets first. A
// tranche reads the same pinned inventory as tranche 0, acquires only the
// image requests its plan's `discovery_selection` selects by set code or
// count, and records every other image request as explicitly deferred, so
// those Printings keep their explicit image gaps. Earlier tranches' images
// stay published; re-selected ones are skipped unchanged (#389).
const imageTranche = {
  description:
    "Every declared English paper Printing fact from the pinned bulk inventory, acquiring only the normal JPEG Printing Images its plan selects (an image tranche).",
  requiredSurfaces: ["bulk-data"],
  requestUrlForSurface: bulkSurfaceUrl,
  acquiredDiscoveryRoles: ["listing", "image"],
  selectableDiscoveryRoles: ["image"],
} as const;

export const scryfallSourceAdapterRegistration: SourceAdapterRegistration = {
  adapterVersion: "scryfall-magic-en@1",
  sourceLineage: lineage,
  supportedGame: "magic",
  gameProfileVersion: "magic@1",
  parserContract: "scryfall-magic-card-pilot@1",
  maximumSnapshotBytes: 2 * 1024 * 1024,
  archiveExtraction: {
    matches: ({ url }) => /^https:\/\/data\.scryfall\.io\/default-cards\/default-cards-\d{14}\.jsonl\.gz$/u.test(url),
    maximumSnapshotBytes: scryfallArchiveLimits.compressedBytes,
    pin: scryfallCapturedBulkPin,
    record(bytes, cutoff) {
      const card = object(withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes))));
      const id = uuid(card.id);
      if (card.object !== "card" || card.uri !== surfaceUrl(id))
        throw new AdapterParseFailure("Scryfall bulk record identity is invalid.");
      const language = text(card.lang);
      const games = list(card.games).map(text);
      if (typeof card.digital !== "boolean")
        throw new AdapterParseFailure("Scryfall physical availability is missing.");
      const release = issuedDate(card.released_at);
      const exclusion =
        language !== "en"
          ? "non_english"
          : !games.includes("paper")
            ? "not_paper"
            : card.digital
              ? "digital"
              : release > cutoff
                ? "preview"
                : card.layout === "front_card"
                  ? "incidental_deck_indicator"
                  : tokenLayoutExclusion(card);
      if (exclusion !== null) return { sourceKey: id, exclusion, observations: [], requests: [] };
      const parsed = assembleScryfallRecord(bytes, surfaceUrl(id), cutoff);
      return {
        sourceKey: id,
        exclusion: null,
        observations:
          parsed.kind === "requires_review"
            ? [{ sourceKey: id, value: parsed.observations[0] }]
            : parsed.observations.map((value) => ({
                sourceKey: `${id}:${value.identity_evidence.variant_key}`,
                value,
              })),
        requests: parsed.images.map((image) => ({
          role: "image",
          url: image.source_url,
          headers: { accept: "image/jpeg", "user-agent": userAgent },
        })),
      };
    },
  },
  requestCapacity: 108_691,
  minimumRateLimitBackoffMilliseconds: 30_000,
  // #389 adaptive pacing bounds, cited to the retained 2026-09-14 access policy.
  hostPacing: [
    {
      hostname: "api.scryfall.com",
      kind: "page",
      floorMs: 200,
      ceilingMs: 4_000,
      maximumConcurrency: 1,
      evidence:
        "acceptance/fixtures/real-sources/2026-09-14-scryfall/README.md: retained rate-limit policy allows 10 requests/s on card endpoints (2/s search, 10/min bulk metadata) and bans for 30 s after HTTP 429; 5/s at the floor stays below it.",
    },
    {
      hostname: "cards.scryfall.io",
      kind: "asset",
      floorMs: 50,
      ceilingMs: 2_000,
      maximumConcurrency: 4,
      evidence:
        "acceptance/fixtures/real-sources/2026-09-14-scryfall/README.md: file surfaces state no numerical limit but ask for considerate bounded acquisition, so concurrency is capped at 4.",
    },
  ],
  origin: "production",
  requestSurface: { kind: "credential-free-https" },
  reconciliationCapability: "catalogue",
  printingAdmission: "source_qualification",
  // Owner decision (#327, 2026-09-21): tranche 0 publishes facts with zero
  // images, so the exact record/finish/illustration qualification establishes
  // a new Printing and its image stays an explicit gap.
  printingNoveltyProof: "qualified_source_record",
  qualifiesCardDesignIdentity: qualifiesDesign,
  qualifiesPrintingIdentity(evidence) {
    const attributes = evidence.observedCardAndPrinting.printing?.game_data?.attributes;
    return (
      qualifiesDesign(evidence) &&
      evidence.observedCardAndPrinting.printing?.game_data?.profile === "magic@1" &&
      ["nonfoil", "foil", "etched"].includes(evidence.variantKey ?? "") &&
      attributes?.finish === evidence.variantKey &&
      typeof attributes.set_code === "string" &&
      typeof attributes.collector_number === "string" &&
      evidence.artworkFingerprint?.startsWith("scryfall:illustration:") === true
    );
  },
  reconciliationAreas: ["catalogue"],
  requiredSurfaces: ["bulk-data"],
  requestUrlForSurface: bulkSurfaceUrl,
  coverageContracts: {
    "representative-english-paper": coverage,
    "facts-only": factsOnly,
    "image-tranche": imageTranche,
  },
  // An image tranche selects by the Scryfall set code of the record that
  // claimed the image; a reviewable record keeps its code in the sidecar.
  discoverySelectionGroup: scryfallSetCode,
  parseBytes(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (context.url === scryfallBulkMetadataUrl) {
      scryfallBulkPin(bytes);
      return [];
    }
    return assembleScryfallRecord(bytes, context.url).observations;
  },
  discoverRequests(bytes, context) {
    if (context.mediaType?.startsWith("image/")) return [];
    if (context.url === scryfallBulkMetadataUrl) {
      const pin = scryfallBulkPin(bytes);
      return [
        {
          role: "listing",
          discoveryKey: `bulk-${pin.timestamp}-${pin.compressedBytes}`,
          url: pin.url,
          headers: {
            accept: "application/gzip, application/octet-stream;q=0.9",
            "accept-encoding": "identity",
            "user-agent": userAgent,
          },
        },
      ];
    }
    return assembleScryfallRecord(bytes, context.url).images.map((image) => ({
      role: "image",
      url: image.source_url,
      headers: { accept: "image/jpeg", "user-agent": userAgent },
    }));
  },
};

function scryfallSetCode(observation: unknown): string | null {
  const value = observation as {
    printing?: { game_data?: { attributes?: { set_code?: unknown } } };
    source_sidecar?: { source_record_json?: unknown };
  } | null;
  const code = value?.printing?.game_data?.attributes?.set_code;
  if (typeof code === "string") return code;
  const record = value?.source_sidecar?.source_record_json;
  if (typeof record !== "string") return null;
  try {
    const set: unknown = (JSON.parse(record) as { set?: unknown }).set;
    return typeof set === "string" ? set : null;
  } catch {
    return null;
  }
}

/**
 * Owner ruling (#327, 2026-09-21) for `token`-layout records whose type line
 * lacks the Token prefix. The layout alone never establishes a token: a real
 * gameplay type with rules text is a gameplay Card; the explicitly named World
 * Championships advertising inserts and the "Card"/"Stickers" or self-described
 * reminder inserts are outside Card scope. Anything else stays unresolved.
 * Returns null for records this ruling does not apply to.
 */
export function tokenLayoutRuling(
  card: Record<string, unknown>,
): "gameplay" | "advertising" | "non_card_insert" | "category_unresolved" | null {
  const typeLine = typeof card.type_line === "string" ? card.type_line : "";
  if (card.layout !== "token" || /^Token(?: |$)/u.test(typeLine)) return null;
  const rules = typeof card.oracle_text === "string" ? card.oracle_text.trim() : "";
  if (typeLine === "Card" && !rules && /^\d{4} World Championships Ad$/u.test(String(card.name))) return "advertising";
  if (typeLine === "Card" || typeLine === "Stickers" || /\bthis reminder card\b/u.test(rules)) return "non_card_insert";
  return typeLine.trim() && rules ? "gameplay" : "category_unresolved";
}

function tokenLayoutExclusion(card: Record<string, unknown>) {
  const ruling = tokenLayoutRuling(card);
  return ruling === "advertising" || ruling === "non_card_insert" ? ruling : null;
}

function qualifiesDesign(evidence: SourcePrintingIdentityEvidence) {
  return (
    evidence.observedCardAndPrinting.card?.game === "magic" &&
    evidence.observedCardAndPrinting.card.official_identity.kind === "unknown" &&
    typeof evidence.cardDesignKey === "string" &&
    evidence.cardDesignKey.startsWith("oracle:") &&
    uuidPattern.test(evidence.cardDesignKey.slice("oracle:".length)) &&
    typeof evidence.locator === "string" &&
    uuidPattern.test(evidence.locator)
  );
}

function assembleScryfallRecord(bytes: Uint8Array, sourceUrl: string, cutoff = "2026-09-14") {
  const card = object(withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes))));
  const id = uuid(card.id);
  if (sourceUrl !== surfaceUrl(id) || card.uri !== sourceUrl || card.object !== "card")
    throw new AdapterParseFailure("Scryfall response does not match its exact selected record.");
  if (card.lang !== "en" || card.digital !== false || !list(card.games).map(text).includes("paper"))
    throw new AdapterParseFailure("Scryfall pilot requires explicit English physical availability.");
  // The pilot's issue evidence predates this cutoff. Never use parser wall time
  // to silently turn a preview into an issued Printing on replay.
  if (issuedDate(card.released_at) > cutoff)
    throw new AdapterParseFailure("Scryfall pilot requires retained issued-card release evidence.");
  const layout = text(card.layout);
  const art = layout === "art_series";
  const tokenRuling = tokenLayoutRuling(card);
  // The per-record pilot path has no exclusion outcome; an excluded kind stays reviewable there.
  const categoryUnresolved = tokenRuling !== null && tokenRuling !== "gameplay";
  const token = (layout === "token" && tokenRuling === null) || layout === "double_faced_token";
  if (art && (card.set_type !== "memorabilia" || card.type_line !== "Card // Card"))
    throw new AdapterParseFailure("Scryfall Card category evidence is contradictory.");
  const faces = card.card_faces === undefined ? [card] : list(card.card_faces).map(object);
  let roles: ("front" | "back")[];
  try {
    roles = magicFaceRoles(layout, faces.length);
  } catch (error) {
    throw new AdapterParseFailure("Scryfall layout and physical faces disagree.", { cause: error });
  }
  const twoSided = roles.includes("back");
  const faceRole = (index: number) => roles[index]!;
  const reversible = layout === "reversible_card";
  const oracle = uuid(reversible ? faces[0]!.oracle_id : card.oracle_id);
  const design = reversible ? faces[0]! : card;
  const designFaces = reversible ? [design] : faces;
  if (
    reversible &&
    (card.oracle_id !== undefined ||
      faces.some((face) => uuid(face.oracle_id) !== oracle || face.layout !== design.layout))
  )
    throw new AdapterParseFailure("Reversible sides with different designs require explicit identity handling.");
  const finishes = list(card.finishes).map(text);
  if (
    !finishes.length ||
    new Set(finishes).size !== finishes.length ||
    finishes.some((finish) => !["nonfoil", "foil", "etched"].includes(finish)) ||
    card.foil !== finishes.includes("foil") ||
    card.nonfoil !== finishes.includes("nonfoil")
  )
    throw new AdapterParseFailure("Scryfall finish availability is incomplete or contradictory.");
  const setCode = text(card.set);
  const collectorNumber = text(card.collector_number);
  const rarity = text(card.rarity);
  const colourIdentity = colours(card.color_identity);
  const illustration = card.illustration_id ?? faces[0]!.illustration_id;
  // A missing illustration is an unresolved locator, never artwork equivalence
  // or qualification. This keeps the observation available for explicit review.
  const fingerprint =
    illustration == null ? `scryfall:unresolved-artwork:${id}` : `scryfall:illustration:${uuid(illustration)}`;
  const sourceImage = (face: Record<string, unknown>, role: "front" | "back") => {
    if (face.image_uris === undefined) return [];
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
    return [{ role, source_url: url.href, artwork_fingerprint: fingerprint }];
  };
  const images = (twoSided ? faces : [card]).flatMap((face, index) => sourceImage(face, faceRole(index)));
  const issues: ScryfallSourceAdmissionEvidenceObservation["issues"][number][] = [];
  if (categoryUnresolved) issues.push({ code: "category_unresolved", source_paths: ["layout", "type_line"] });
  if (categoryUnresolved || reversible) {
    // Reviewable meaning never bypasses validation of the retained source claims.
    for (const face of new Set([card, ...faces])) {
      if (face !== card && face.object !== "card_face")
        throw new AdapterParseFailure("Scryfall face object is invalid.");
      text(face.name);
      if (face !== card || !reversible) text(face.type_line);
      else optionalText(face.type_line);
      optionalText(face.mana_cost);
      optionalText(face.oracle_text);
      optionalText(face.power);
      optionalText(face.toughness);
      optionalText(face.printed_text);
      optionalText(face.artist);
      if (face.colors !== undefined) colours(face.colors);
      if (face.illustration_id != null) uuid(face.illustration_id);
      if (face.oracle_id !== undefined) uuid(face.oracle_id);
      sourceImage(face, face === card ? "front" : faceRole(faces.indexOf(face)));
    }
  }
  if (reversible) {
    const designLayout = text(design.layout);
    if (!magicLayouts.some((known) => known === designLayout))
      throw new AdapterParseFailure("Scryfall reversible design layout is unsupported.");
    // Physical front/back entries do not supply a complete logical design
    // when that design itself requires multiple parts. Preserve the source
    // claims for review instead of duplicating or borrowing missing parts.
    let logicalPartsComplete = true;
    try {
      magicFaceRoles(designLayout, designFaces.length);
    } catch {
      // Only this known layout/count mismatch becomes reviewable evidence.
      // Source identity, field structure and image-authority checks still fail.
      logicalPartsComplete = false;
    }
    if (!logicalPartsComplete)
      issues.push({ code: "logical_parts_unresolved", source_paths: ["card_faces.0.layout", "card_faces.1.layout"] });
  }
  if (issues.length) {
    const observation: ScryfallSourceAdmissionEvidenceObservation = {
      observation_type: "source_admission_evidence",
      game: "magic",
      source_lineage: lineage,
      locator: id,
      declared_finishes: finishes,
      issues,
      appearance_evidence: { images },
      source_sidecar: { source_record_json: JSON.stringify(card) },
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: 1,
        parsed_record_count: 1,
      },
    };
    return { kind: "requires_review" as const, observations: [observation], images };
  }
  const category = art ? "art" : token || (reversible && design.layout === "token") ? "token" : "gameplay";
  const cardAttributes = art
    ? {}
    : {
        layout: reversible ? text(design.layout) : layout,
        type_line: text(design.type_line),
        colour_identity: colourIdentity,
        faces: designFaces.map((face, index) => ({
          role: reversible ? "front" : faceRole(index),
          name: text(face.name),
          mana_cost: optionalText(face.mana_cost),
          type_line: optionalText(face.type_line),
          colours: face.colors === undefined ? null : colours(face.colors),
          oracle_text: optionalText(face.oracle_text),
          power: optionalText(face.power),
          toughness: optionalText(face.toughness),
        })),
      };
  const printedFaces = faces.map((face, index) => ({
    role: faceRole(index),
    name: text(face.name),
    printed_rules_text: art ? null : optionalText(face.printed_text),
  }));
  const observations = finishes.map((finish) => {
    const attributes = {
      set_code: setCode,
      collector_number: collectorNumber,
      finish,
      layout,
      faces: printedFaces,
      artists: [
        ...new Set(
          (twoSided ? faces : [card]).flatMap((face) =>
            face.artist == null || face.artist === "" ? [] : [text(face.artist)],
          ),
        ),
      ],
      reverse_face: twoSided ? text(faces[1]!.name) : null,
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
        name: text(design.name),
        effective_rules_text: art
          ? null
          : designFaces
              .map((face) => optionalText(face.oracle_text))
              .filter(Boolean)
              .join("\n") || null,
        game_data: { profile: "magic@1", attributes: cardAttributes },
      },
      card_identity_evidence: { source_design_key: `oracle:${oracle}` },
      printing: {
        rarity: { raw: rarity, normalized: rarity },
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
        ...(illustration == null ? { artwork_identity_explicit: false } : {}),
        printed_fields_digest: createHash("sha256")
          .update(
            JSON.stringify({
              ...attributes,
              illustrations: faces.map((face) => (face.illustration_id == null ? null : uuid(face.illustration_id))),
              frame: card.frame,
              border_color: card.border_color,
              full_art: card.full_art,
              textless: card.textless,
            }),
          )
          .digest("hex"),
        treatment: finish,
        demonstrably_novel: card.image_status === "highres_scan",
        novelty_basis:
          illustration == null || images[0] === undefined
            ? null
            : {
                kind: "source_printing_image",
                source_url: images[0]!.source_url,
                artwork_fingerprint: fingerprint,
              },
      },
      appearance_evidence: { images },
      memberships: { products: [], distribution_contexts: [], source_buckets: [setCode] },
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
          role: faceRole(index),
          id: face === card ? null : (face.id ?? null),
          oracle_id: face === card ? null : (face.oracle_id ?? null),
          illustration_id: face.illustration_id == null ? null : uuid(face.illustration_id),
        })),
      },
    };
  });
  return { kind: "assembled" as const, observations, images };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("Scryfall required object is missing.");
  return value as Record<string, unknown>;
}
function colours(value: unknown): string[] {
  const values = list(value).map(text);
  if (new Set(values).size !== values.length || values.some((colour) => !["W", "U", "B", "R", "G"].includes(colour)))
    throw new AdapterParseFailure("Scryfall colours must be unique Magic colour symbols.");
  return values;
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
function issuedDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new AdapterParseFailure("Scryfall issued-card release date is invalid.");
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
    throw new AdapterParseFailure("Scryfall issued-card release date is invalid.");
  return value;
}
function uuid(value: unknown) {
  const id = text(value);
  if (!uuidPattern.test(id)) throw new AdapterParseFailure("Scryfall source identifier is invalid.");
  return id;
}
