import { AdministrationProblem } from "./administration-problem.mjs";
import {
  officialRawAdapterContracts,
} from "./official-raw-adapter-contracts.mjs";
import { parseOnePieceOfficialErrataHtml } from "./one-piece-official-errata-html.mjs";
import { sha256Text } from "./serialization";

export type OfficialSourceContract = Readonly<{
  supportedGame: "one-piece" | "fusion-world" | "digimon" | "gundam";
  partition: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
  origin: string;
  pathnamePrefix: string;
  requiredSurfaces: readonly string[];
}>;

export type SourceAdapterRegistration = Readonly<{
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  parserContract: string;
  maximumSnapshotBytes: number;
  origin: "production" | "synthetic_fixture";
  requestSurface:
    | Readonly<{ kind: "credential-free-https" }>
    | Readonly<{ kind: "exact-url"; url: string }>
    | Readonly<{ kind: "synthetic-fixture" }>;
  reconciliationCapability: "catalogue" | "errata" | "unavailable";
  parse?: (
    document: unknown,
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  parseBytes?: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  discoverRequests?: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly {
    role: "listing" | "detail" | "product_detail" | "image";
    url: string;
    headers: Record<string, string>;
  }[];
  requiredSurfaces?: readonly string[];
  requestUrlForSurface?: (surface: string) => string;
  officialSourceContract?: OfficialSourceContract;
}>;

const parseSourceDocument = (document: unknown): readonly unknown[] => {
  if (
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document)
  ) {
    const record = document as {
      cards?: unknown;
      product_surfaces?: unknown;
    };
    if (
      Array.isArray(record.cards) ||
      Array.isArray(record.product_surfaces)
    ) {
      return [
        ...(Array.isArray(record.cards) ? record.cards : []),
        ...(Array.isArray(record.product_surfaces)
          ? record.product_surfaces
          : []),
      ];
    }
  }
  return [document];
};

const parsePinnedCardDocument = (document: unknown): readonly unknown[] => {
  if (
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document) &&
    Array.isArray((document as { cards?: unknown }).cards)
  ) {
    const source = document as {
      cards: unknown[];
      legality_rules?: unknown;
      legality_completeness?: unknown;
    };
    return [
      ...source.cards,
      ...(source.legality_rules === undefined
        ? []
        : [
            {
              observation_type: "legality_rules",
              legality_rules: source.legality_rules,
              completeness: source.legality_completeness,
            },
          ]),
    ];
  }
  return [document];
};

async function onePieceOfficialLegalityParser(
  document: unknown,
): Promise<readonly unknown[]> {
  const envelope = requiredRecord(document, "One Piece Official Source response");
  assertOnlyFields(envelope, ["one_piece"]);
  const payload = requiredRecord(envelope.one_piece, "One Piece response payload");
  return officialLegalityObservations(
    onePieceOfficialSource,
    parseRawSurface(payload, {
      count: "total",
      locale: "locale",
      records: "entries",
      surface: "area",
    }),
    normalizeOnePieceRecord,
  );
}

async function fusionWorldOfficialLegalityParser(
  document: unknown,
): Promise<readonly unknown[]> {
  const envelope = requiredRecord(document, "Fusion World Official Source response");
  assertOnlyFields(envelope, ["fusion_world"]);
  const payload = requiredRecord(
    envelope.fusion_world,
    "Fusion World response payload",
  );
  return officialLegalityObservations(
    fusionWorldOfficialSource,
    parseRawSurface(payload, {
      count: "result_count",
      locale: "territory",
      records: "items",
      surface: "section",
    }),
    normalizeFusionWorldRecord,
  );
}

async function digimonOfficialLegalityParser(
  document: unknown,
): Promise<readonly unknown[]> {
  const envelope = requiredRecord(document, "Digimon Official Source response");
  assertOnlyFields(envelope, ["digimon"]);
  const payload = requiredRecord(envelope.digimon, "Digimon response payload");
  return officialLegalityObservations(
    digimonOfficialSource,
    parseRawSurface(payload, {
      count: "count",
      locale: "language",
      records: "rows",
      surface: "feed",
    }),
    normalizeDigimonRecord,
  );
}

function gundamOfficialLegalityParser(
  contract: OfficialSourceContract,
): (document: unknown) => Promise<readonly unknown[]> {
  return async (document) => {
    const envelope = requiredRecord(document, "Gundam Official Source response");
    assertOnlyFields(envelope, ["gundam"]);
    const payload = requiredRecord(envelope.gundam, "Gundam response payload");
    return officialLegalityObservations(
      contract,
      parseRawSurface(payload, {
        count: "hits",
        locale: "locale",
        records: "results",
        surface: "endpoint",
      }),
      normalizeGundamRecord,
    );
  };
}

const commonOfficialSurfaceNames = [
  "discovery",
  "legality_card_details",
  "legality_rules",
  "legality_history",
] as const;

function officialSurfaceNames(
  supportedGame: "one-piece" | "fusion-world" | "digimon" | "gundam",
): readonly string[] {
  return supportedGame === "one-piece"
    ? [
        ...commonOfficialSurfaceNames,
        "block_policy",
        "release_timing",
        "don_rules",
      ]
    : commonOfficialSurfaceNames;
}

function officialSourceContract(
  supportedGame: "one-piece" | "fusion-world" | "digimon" | "gundam",
  partition: OfficialSourceContract["partition"],
  origin: string,
  pathnamePrefix: string,
): OfficialSourceContract {
  return Object.freeze({
    supportedGame,
    partition,
    origin,
    pathnamePrefix,
    requiredSurfaces: Object.freeze([
      ...officialSurfaceNames(supportedGame),
    ]),
  });
}

const onePieceOfficialSource = officialSourceContract(
  "one-piece",
  "EN-OCEANIA",
  "https://en.onepiece-cardgame.com",
  "/",
);
const fusionWorldOfficialSource = officialSourceContract(
  "fusion-world",
  "EN-OCEANIA",
  "https://www.dbs-cardgame.com",
  "/fw/en/",
);
const digimonOfficialSource = officialSourceContract(
  "digimon",
  "EN-OCEANIA",
  "https://world.digimoncard.com",
  "/",
);
const gundamAsiaOfficialSource = officialSourceContract(
  "gundam",
  "EN-ASIA",
  "https://www.gundam-gcg.com",
  "/asia-en/",
);
const gundamUsOfficialSource = officialSourceContract(
  "gundam",
  "EN-US",
  "https://www.gundam-gcg.com",
  "/en/",
);

type RawSurface = {
  name: string;
  locale: string;
  records: unknown[];
};

type RawSurfaceFields = {
  count: string;
  locale: string;
  records: string;
  surface: string;
};

type RawRecordNormalizer = (
  value: unknown,
  surface: string,
  contract: OfficialSourceContract,
) => Promise<Record<string, unknown>>;

const ruleBearingSurfaces = new Set([
  "legality_rules",
  "legality_history",
  "block_policy",
  "release_timing",
  "don_rules",
]);

function parseRawSurface(
  payload: Record<string, unknown>,
  fields: RawSurfaceFields,
): RawSurface {
  assertOnlyFields(payload, [
    fields.surface,
    fields.locale,
    fields.count,
    fields.records,
  ]);
  const name = payload[fields.surface];
  const locale = payload[fields.locale];
  const declaredCount = requiredCount(
    payload[fields.count],
    `Official ${String(name)} result count`,
  );
  const records = payload[fields.records];
  if (
    typeof name !== "string" ||
    typeof locale !== "string" ||
    !Array.isArray(records) ||
    records.length !== declaredCount
  ) {
    throw new Error(
      "The raw Official Source response has an invalid surface, locale, or record count.",
    );
  }
  return { name, locale, records };
}

async function officialLegalityObservations(
  contract: OfficialSourceContract,
  surface: RawSurface,
  normalizeRecord: RawRecordNormalizer,
): Promise<readonly unknown[]> {
  if (
    !contract.requiredSurfaces.includes(surface.name) ||
    surface.locale !== contract.partition
  ) {
    throw new Error(
      "The raw Official Source response does not identify the required lineage surface.",
    );
  }
  if (surface.name === "discovery" && surface.records.length === 0) {
    throw new Error("Official Source discovery retained no live records.");
  }
  const records = await Promise.all(
    surface.records.map((record) =>
      normalizeRecord(record, surface.name, contract)
    ),
  );
  validateOfficialSurfaceRecords(surface.name, records, contract);
  const retainedSurfaceEvidence = {
    observation_type: "official_surface_evidence",
    surface: surface.name,
    records,
    completeness: completeObservationEvidence(),
  };
  if (surface.name === "legality_card_details") {
    return [
      retainedSurfaceEvidence,
      ...records.map((card) =>
        parseOfficialLegalityCardDetail(card, contract)
      ),
    ];
  }
  if (!ruleBearingSurfaces.has(surface.name)) {
    return [retainedSurfaceEvidence];
  }
  return [
    retainedSurfaceEvidence,
    {
      observation_type: "legality_rules",
      legality_rules: records.map((rule) =>
        parseOfficialLegalityNotice(rule, contract)
      ),
      completeness: completeObservationEvidence(),
    },
  ];
}

async function normalizeOnePieceRecord(
  value: unknown,
  surface: string,
  contract: OfficialSourceContract,
): Promise<Record<string, unknown>> {
  if (surface === "discovery") {
    const record = exactRawRecord(value, ["key", "area", "href"]);
    return discoveryRecord(record.key, record.area, record.href);
  }
  if (surface === "legality_card_details") {
    const record = exactRawRecord(value, [
      "source_record_id", "source_url", "card_number", "name", "Category",
      "Color", "Cost", "Life", "Attribute", "Power", "Counter", "Type",
      "Block icon", "Effect", "Trigger", "Rarity", "Illustration",
      "image_url",
    ]);
    return normalizedRawCard(contract, {
      sourceId: rawString(record.source_record_id, "source_record_id"),
      sourceUrl: rawString(record.source_url, "source_url"),
      cardNumber: rawString(record.card_number, "card_number"),
      name: rawString(record.name, "name"),
      rulesText: nullableRawText(record.Effect) ?? "",
      imageUrl: rawString(record.image_url, "image_url"),
      rarity: nullableRawText(record.Rarity),
      variantKey: rawString(record.source_record_id, "source_record_id"),
      printingAttributes: {
        illustration_types: rawList(record.Illustration).map((item) =>
          item.toLowerCase()
        ),
      },
      cardAttributes: {
        card_type: rawString(record.Category, "Category").toLowerCase(),
        colours: rawColours(record.Color),
        cost: rawInteger(record.Cost),
        life: rawInteger(record.Life),
        battle_attributes: rawList(record.Attribute),
        power: rawInteger(record.Power),
        counter: rawInteger(record.Counter),
        traits: rawList(record.Type),
        block_icons: rawList(record["Block icon"]),
        effect_text: nullableRawText(record.Effect),
        trigger_text: nullableRawText(record.Trigger),
      },
    });
  }
  return normalizeOnePieceNotice(value, contract);
}

async function normalizeFusionWorldRecord(
  value: unknown,
  surface: string,
  contract: OfficialSourceContract,
): Promise<Record<string, unknown>> {
  if (surface === "discovery") {
    const record = exactRawRecord(value, ["request", "section", "url"]);
    return discoveryRecord(record.request, record.section, record.url);
  }
  if (surface === "legality_card_details") {
    const record = exactRawRecord(value, [
      "source_url", "card_number", "name", "Card Type",
      "Color", "Cost", "Specified Cost", "Power", "Combo Power",
      "Special Traits", "Skills", "Rarity", "variant_suffix", "image_urls",
    ]);
    const cardNumber = rawString(record.card_number, "card_number");
    const variantKey = nullableRawText(record.variant_suffix);
    return normalizedRawCard(contract, {
      sourceId: `${cardNumber}:${variantKey ?? "base"}`,
      sourceUrl: rawString(record.source_url, "source_url"),
      cardNumber,
      name: rawString(record.name, "name"),
      rulesText: nullableRawText(record.Skills) ?? "",
      imageUrl: rawFirstString(record.image_urls, "image_urls"),
      rarity: nullableRawText(record.Rarity),
      variantKey,
      printingAttributes: {},
      cardAttributes: {
        card_type: rawString(record["Card Type"], "Card Type").toLowerCase(),
        colours: rawColours(record.Color),
        cost: rawInteger(record.Cost),
        specified_cost: rawSpecifiedCost(record["Specified Cost"]),
        power: rawInteger(record.Power),
        combo_power: rawInteger(record["Combo Power"]),
        traits: rawList(record["Special Traits"]),
        skills: rawTextSections(record.Skills),
      },
    });
  }
  return normalizeFusionWorldNotice(value, contract);
}

async function normalizeDigimonRecord(
  value: unknown,
  surface: string,
  contract: OfficialSourceContract,
): Promise<Record<string, unknown>> {
  if (surface === "discovery") {
    const record = exactRawRecord(value, ["request_id", "feed", "link"]);
    return discoveryRecord(record.request_id, record.feed, record.link);
  }
  if (surface === "legality_card_details") {
    const record = exactRawRecord(value, [
      "popup_id", "source_url", "card_number", "name", "cardcategory",
      "Color", "Lv", "Play Cost", "Use Cost", "DP", "Form", "Attribute",
      "Type", "Digivolution Cost", "Effect", "Inherited Effect",
      "Security Effect", "DUAL Color", "DUAL Cost", "Link DP", "Rarity",
      "Alternative Art", "image_url",
    ]);
    return normalizedRawCard(contract, {
      sourceId: rawString(record.popup_id, "popup_id"),
      sourceUrl: rawString(record.source_url, "source_url"),
      cardNumber: rawString(record.card_number, "card_number"),
      name: rawString(record.name, "name"),
      rulesText: nullableRawText(record.Effect) ?? "",
      imageUrl: rawString(record.image_url, "image_url"),
      rarity: nullableRawText(record.Rarity),
      variantKey: rawString(record.popup_id, "popup_id"),
      printingAttributes: {
        alternative_art:
          rawString(record["Alternative Art"], "Alternative Art") === "yes",
      },
      cardAttributes: {
        card_type: rawString(record.cardcategory, "cardcategory").toLowerCase(),
        colours: rawColours(record.Color),
        level: rawInteger(record.Lv),
        play_cost: rawInteger(record["Play Cost"]),
        use_cost: rawInteger(record["Use Cost"]),
        dp: rawInteger(record.DP),
        form: nullableRawText(record.Form),
        attribute: nullableRawText(record.Attribute),
        traits: rawList(record.Type),
        digivolution_requirements: rawDigivolutionRequirements(
          record["Digivolution Cost"],
        ),
        text_sections: [
          ...rawTextSections(record.Effect, "effect"),
          ...rawTextSections(record["Inherited Effect"], "inherited_effect"),
          ...rawTextSections(record["Security Effect"], "security_effect"),
        ],
        dual_colours: rawColours(record["DUAL Color"]),
        dual_cost: rawInteger(record["DUAL Cost"]),
        link_dp: rawInteger(record["Link DP"]),
      },
    });
  }
  return normalizeDigimonNotice(value, contract);
}

async function normalizeGundamRecord(
  value: unknown,
  surface: string,
  contract: OfficialSourceContract,
): Promise<Record<string, unknown>> {
  if (surface === "discovery") {
    const record = exactRawRecord(value, ["request_key", "endpoint", "href"]);
    return discoveryRecord(record.request_key, record.endpoint, record.href);
  }
  if (surface === "legality_card_details") {
    const record = exactRawRecord(value, [
      "detailSearch", "source_url", "card_number", "name", "type", "Color",
      "Level", "Cost", "Block", "Effect", "Zone", "Trait", "Link", "AP",
      "HP", "Title", "Rarity", "alternate_art", "image_url",
    ]);
    return normalizedRawCard(contract, {
      sourceId: rawString(record.detailSearch, "detailSearch"),
      sourceUrl: rawString(record.source_url, "source_url"),
      cardNumber: rawString(record.card_number, "card_number"),
      name: rawString(record.name, "name"),
      rulesText: nullableRawText(record.Effect) ?? "",
      imageUrl: rawString(record.image_url, "image_url"),
      rarity: nullableRawText(record.Rarity),
      variantKey: rawString(record.detailSearch, "detailSearch"),
      printingAttributes: {
        alternate_art:
          rawString(record.alternate_art, "alternate_art") === "yes",
      },
      cardAttributes: {
        card_type: rawString(record.type, "type").toLowerCase(),
        colours: rawColours(record.Color),
        level: rawInteger(record.Level),
        cost: rawInteger(record.Cost),
        block_icon: nullableRawText(record.Block),
        effect_text: nullableRawText(record.Effect),
        zone: nullableRawText(record.Zone),
        traits: rawList(record.Trait),
        link_condition: nullableRawText(record.Link),
        ap: rawInteger(record.AP),
        hp: rawInteger(record.HP),
        series_titles: rawList(record.Title),
      },
    });
  }
  return normalizeGundamNotice(value, contract);
}

function exactRawRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const record = requiredRecord(value, "Official Source raw record");
  assertOnlyFields(record, fields);
  return record;
}

function rawString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Official Source raw field ${name} must be a non-empty string.`);
  }
  return value.trim();
}

function nullableRawText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return rawString(value, "text");
}

function rawExactText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Official Source raw field ${name} must be non-empty text.`);
  }
  return value;
}

function rawInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Official Source numeric field must be a non-negative integer.");
  }
  return parsed;
}

function rawList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : value === null || value === undefined || value === ""
      ? []
      : typeof value === "string"
        ? value.split(/[,/]/)
        : [value];
  return values.map((item) => rawString(item, "list item"));
}

function rawFirstString(value: unknown, name: string): string {
  const values = rawList(value);
  if (values.length === 0) {
    throw new Error(`Official Source raw field ${name} must not be empty.`);
  }
  return values[0]!;
}

function rawColours(value: unknown): string[] {
  return rawList(value).map((colour) => colour.toLowerCase());
}

function rawSpecifiedCost(value: unknown): { colour: string; count: number }[] {
  return rawList(value).map((entry) => {
    const match = /^(red|blue|green|yellow|black)\s*[:x]\s*(\d+)$/i.exec(entry);
    if (match === null) {
      throw new Error("Official Source Specified Cost is not representable.");
    }
    return { colour: match[1]!.toLowerCase(), count: Number(match[2]) };
  });
}

function rawDigivolutionRequirements(
  value: unknown,
): { cost: number }[] {
  const cost = rawInteger(value);
  return cost === null ? [] : [{ cost }];
}

function rawTextSections(
  value: unknown,
  kind = "ordinary",
): { kind: string; text: string }[] {
  const text = nullableRawText(value);
  return text === null ? [] : [{ kind, text }];
}

function discoveryRecord(
  requestId: unknown,
  surface: unknown,
  url: unknown,
): Record<string, unknown> {
  return {
    request_id: rawString(requestId, "discovery request"),
    surface: rawString(surface, "discovery surface"),
    url: rawString(url, "discovery URL"),
  };
}

function normalizedRarity(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFC").trim().toLowerCase();
  const aliases: Record<string, string> = {
    c: "common",
    common: "common",
    r: "rare",
    rare: "rare",
    sr: "super_rare",
    "super rare": "super_rare",
    ur: "ultra_rare",
    "ultra rare": "ultra_rare",
  };
  return aliases[normalized] ?? normalized.replaceAll(/[^a-z0-9]+/g, "_");
}

async function normalizedRawCard(
  contract: OfficialSourceContract,
  input: {
    sourceId: string;
    sourceUrl: string;
    cardNumber: string;
    name: string;
    rulesText: string;
    imageUrl: string;
    rarity: string | null;
    variantKey: string | null;
    printingAttributes: Record<string, unknown>;
    cardAttributes: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  assertOfficialSourceUrl(input.sourceUrl, contract);
  assertOfficialSourceUrl(input.imageUrl, contract);
  const artworkFingerprint = `sha256:${await sha256Text(`image\0${input.imageUrl}`)}`;
  const printedFieldsDigest = `sha256:${await sha256Text(
    `printing\0${input.cardNumber}\0${input.rulesText}\0${JSON.stringify(input.printingAttributes)}`,
  )}`;
  return {
    source_id: input.sourceId,
    source_url: input.sourceUrl,
    card_number: input.cardNumber,
    title: input.name,
    rules_text: input.rulesText,
    detail: input.cardAttributes,
    printing: {
      rarity_raw: input.rarity,
      rarity_normalized: normalizedRarity(input.rarity),
      printed_text: input.rulesText,
      detail: input.printingAttributes,
      locator: `${contract.supportedGame}:${input.sourceId}`,
      variant_key: input.variantKey,
      artwork_fingerprint: artworkFingerprint,
      printed_fields_digest: printedFieldsDigest,
      treatment: null,
      image_url: input.imageUrl,
    },
  };
}

type RawNotice = {
  sourceId: unknown;
  sourceUrl: unknown;
  noticeId: unknown;
  wording: unknown;
  region: unknown;
  format: unknown;
  eventTier: unknown;
  effectiveFrom: unknown;
  effectiveUntil: unknown;
  cardNumbers: unknown;
  actionCode: unknown;
  maximumCopies: unknown;
  relatedCards: unknown;
  membershipAttribute: unknown;
  membershipValues: unknown;
  eligibleBlocks: unknown;
  legalFrom: unknown;
  unresolvedReason: unknown;
};

function normalizedRawNotice(
  input: RawNotice,
  contract: OfficialSourceContract,
): Record<string, unknown> {
  const sourceUrl = rawString(input.sourceUrl, "notice source URL");
  assertOfficialSourceUrl(sourceUrl, contract);
  const actionCode = rawString(input.actionCode, "notice action code")
    .toLowerCase();
  let action: Record<string, unknown>;
  switch (actionCode) {
    case "eligible":
      action = { type: "eligible" };
      break;
    case "ban":
    case "banned":
      action = { type: "ban" };
      break;
    case "copy_limit": {
      const maximumCopies = rawInteger(input.maximumCopies);
      if (maximumCopies === null || maximumCopies < 1) {
        throw new Error("Official Source copy limit is not representable.");
      }
      action = { type: "copy_limit", maximum_copies: maximumCopies };
      break;
    }
    case "combination":
      action = {
        type: "prohibited_combination",
        with_card_numbers: rawList(input.relatedCards),
      };
      break;
    case "membership":
      action = {
        type: "membership",
        attribute: rawString(input.membershipAttribute, "membership attribute"),
        includes_any: rawList(input.membershipValues),
      };
      break;
    case "rotation":
      action = { type: "rotation", eligible_blocks: rawList(input.eligibleBlocks) };
      break;
    case "release":
      action = {
        type: "release_timing",
        legal_from: rawString(input.legalFrom, "release legal date"),
      };
      break;
    case "unresolved":
      action = {
        type: "unresolved",
        reason: rawString(input.unresolvedReason, "unresolved reason"),
      };
      break;
    default:
      throw new Error(
        `Official Source action code ${actionCode} is not representable.`,
      );
  }
  const wording = rawExactText(input.wording, "notice wording");
  validateNoticeWording(wording, action);
  return {
    source_id: rawString(input.sourceId, "notice source identity"),
    source_url: sourceUrl,
    notice_id: rawString(input.noticeId, "notice identity"),
    official_text: wording,
    scope: {
      region: rawString(input.region, "notice region"),
      format: rawString(input.format, "notice format"),
      event_tier: nullableRawText(input.eventTier),
      effective_from: rawString(input.effectiveFrom, "notice effective date"),
      effective_until: nullableRawText(input.effectiveUntil),
    },
    affected_card_numbers: rawList(input.cardNumbers),
    action,
    representable: true,
  };
}

function normalizeOnePieceNotice(
  value: unknown,
  contract: OfficialSourceContract,
): Record<string, unknown> {
  const record = exactRawRecord(value, [
    "notice_no", "source_url", "published_text", "territory", "format_name",
    "event_class", "start_date", "end_date", "card_numbers",
    "restriction_code", "maximum_copies", "related_cards",
    "membership_attribute", "membership_values", "eligible_blocks",
    "legal_from", "unresolved_reason",
  ]);
  return normalizedRawNotice({
    sourceId: record.notice_no, sourceUrl: record.source_url,
    noticeId: record.notice_no, wording: record.published_text,
    region: record.territory, format: record.format_name,
    eventTier: record.event_class, effectiveFrom: record.start_date,
    effectiveUntil: record.end_date, cardNumbers: record.card_numbers,
    actionCode: record.restriction_code, maximumCopies: record.maximum_copies,
    relatedCards: record.related_cards,
    membershipAttribute: record.membership_attribute,
    membershipValues: record.membership_values,
    eligibleBlocks: record.eligible_blocks, legalFrom: record.legal_from,
    unresolvedReason: record.unresolved_reason,
  }, contract);
}

function normalizeFusionWorldNotice(
  value: unknown,
  contract: OfficialSourceContract,
): Record<string, unknown> {
  const record = exactRawRecord(value, [
    "rule_ref", "canonical_url", "notice", "market", "play_format", "tier",
    "active_on", "expires_on", "cards", "directive", "cap", "paired_cards",
    "filter_field", "filter_values", "blocks", "tournament_legal_date",
    "ambiguity",
  ]);
  return normalizedRawNotice({
    sourceId: record.rule_ref, sourceUrl: record.canonical_url,
    noticeId: record.rule_ref, wording: record.notice, region: record.market,
    format: record.play_format, eventTier: record.tier,
    effectiveFrom: record.active_on, effectiveUntil: record.expires_on,
    cardNumbers: record.cards, actionCode: record.directive,
    maximumCopies: record.cap, relatedCards: record.paired_cards,
    membershipAttribute: record.filter_field,
    membershipValues: record.filter_values, eligibleBlocks: record.blocks,
    legalFrom: record.tournament_legal_date, unresolvedReason: record.ambiguity,
  }, contract);
}

function normalizeDigimonNotice(
  value: unknown,
  contract: OfficialSourceContract,
): Record<string, unknown> {
  const record = exactRawRecord(value, [
    "restriction_id", "link", "body", "language_scope", "ruleset",
    "tournament_level", "applies_from", "applies_until", "card_ids",
    "status_code", "deck_limit", "prohibited_with", "membership_field",
    "membership_terms", "permitted_blocks", "sale_eligible_on", "clarification",
  ]);
  return normalizedRawNotice({
    sourceId: record.restriction_id, sourceUrl: record.link,
    noticeId: record.restriction_id, wording: record.body,
    region: record.language_scope, format: record.ruleset,
    eventTier: record.tournament_level, effectiveFrom: record.applies_from,
    effectiveUntil: record.applies_until, cardNumbers: record.card_ids,
    actionCode: record.status_code, maximumCopies: record.deck_limit,
    relatedCards: record.prohibited_with,
    membershipAttribute: record.membership_field,
    membershipValues: record.membership_terms,
    eligibleBlocks: record.permitted_blocks, legalFrom: record.sale_eligible_on,
    unresolvedReason: record.clarification,
  }, contract);
}

function normalizeGundamNotice(
  value: unknown,
  contract: OfficialSourceContract,
): Record<string, unknown> {
  const record = exactRawRecord(value, [
    "news_id", "url", "text", "region", "format", "event_tier",
    "effective_date", "end_date", "card_numbers", "ruling", "copy_limit",
    "companion_cards", "attribute", "values", "legal_blocks", "legal_from",
    "reason",
  ]);
  return normalizedRawNotice({
    sourceId: record.news_id, sourceUrl: record.url, noticeId: record.news_id,
    wording: record.text, region: record.region, format: record.format,
    eventTier: record.event_tier, effectiveFrom: record.effective_date,
    effectiveUntil: record.end_date, cardNumbers: record.card_numbers,
    actionCode: record.ruling, maximumCopies: record.copy_limit,
    relatedCards: record.companion_cards, membershipAttribute: record.attribute,
    membershipValues: record.values, eligibleBlocks: record.legal_blocks,
    legalFrom: record.legal_from, unresolvedReason: record.reason,
  }, contract);
}

export function requiredOfficialSourceContract(
  adapter: SourceAdapterRegistration,
): OfficialSourceContract {
  if (
    adapter.reconciliationCoverage !== "official_legality" ||
    adapter.officialSourceContract === undefined
  ) {
    throw new Error(
      `Adapter ${adapter.adapterVersion} has no complete Official Source contract.`,
    );
  }
  return adapter.officialSourceContract;
}

function officialSurfaceLabel(name: string): string {
  return name
    .split("_")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function parseOfficialLegalityCardDetail(
  value: unknown,
  contract: OfficialSourceContract,
): Record<string, unknown> {
  const record = requiredRecord(value, "Official legality Card detail");
  assertOnlyFields(record, [
    "source_id",
    "source_url",
    "card_number",
    "title",
    "rules_text",
    "detail",
    "printing",
  ]);
  if (
    typeof record.source_id !== "string" ||
    record.source_id.length === 0 ||
    typeof record.source_url !== "string" ||
    typeof record.card_number !== "string" ||
    record.card_number.length === 0 ||
    typeof record.title !== "string" ||
    record.title.length === 0 ||
    typeof record.rules_text !== "string"
  ) {
    throw new Error(
      "Official legality Card detail identity and wording are required.",
    );
  }
  assertOfficialSourceUrl(record.source_url, contract);
  const detail = parseGameSpecificCardDetail(
    requiredRecord(record.detail, "Official game-specific Card detail"),
    contract.supportedGame,
  );
  const printing = requiredRecord(
    record.printing,
    "Official legality Printing detail",
  );
  assertOnlyFields(printing, [
    "rarity_raw",
    "rarity_normalized",
    "printed_text",
    "detail",
    "locator",
    "variant_key",
    "artwork_fingerprint",
    "printed_fields_digest",
    "treatment",
    "image_url",
  ]);
  if (
    typeof printing.locator !== "string" ||
    typeof printing.artwork_fingerprint !== "string" ||
    typeof printing.printed_fields_digest !== "string" ||
    typeof printing.image_url !== "string"
  ) {
    throw new Error(
      "Official legality Printing detail lacks identity or image evidence.",
    );
  }
  assertOfficialSourceUrl(printing.image_url, contract);
  return {
    card: {
      game: contract.supportedGame,
      official_identity: {
        kind: "card_number",
        value: record.card_number,
      },
      name: record.title,
      effective_rules_text: record.rules_text,
      game_data: {
        profile: `${contract.supportedGame}@1`,
        attributes: detail.card,
      },
    },
    printing: {
      rarity: {
        raw: printing.rarity_raw ?? null,
        normalized: printing.rarity_normalized ?? null,
      },
      printed_rules_text: printing.printed_text ?? null,
      game_data: {
        profile: `${contract.supportedGame}@1`,
        attributes: requiredRecord(
          printing.detail,
          "Official game-specific Printing detail",
        ),
      },
    },
    identity_evidence: {
      locator: printing.locator,
      variant_key: printing.variant_key ?? null,
      artwork_fingerprint: printing.artwork_fingerprint,
      printed_fields_digest: printing.printed_fields_digest,
      treatment: printing.treatment ?? null,
      demonstrably_novel: true,
      novelty_basis: {
        kind: "official_printing_image",
        source_url: printing.image_url,
        artwork_fingerprint: printing.artwork_fingerprint,
      },
    },
    appearance_evidence: {
      images: [
        {
          role: "front",
          source_url: printing.image_url,
          artwork_fingerprint: printing.artwork_fingerprint,
        },
      ],
    },
    completeness: completeObservationEvidence(),
    memberships: {
      products: [],
      distribution_contexts: [],
      source_buckets: [record.source_id],
    },
  };
}

function parseGameSpecificCardDetail(
  detail: Record<string, unknown>,
  game: OfficialSourceContract["supportedGame"],
): { card: Record<string, unknown> } {
  const fields: Record<OfficialSourceContract["supportedGame"], string[]> = {
    "one-piece": [
      "card_type", "colours", "cost", "life", "battle_attributes",
      "power", "counter", "traits", "block_icons", "effect_text",
      "trigger_text",
    ],
    "fusion-world": [
      "card_type", "colours", "cost", "specified_cost", "power",
      "combo_power", "traits", "skills", "leader_faces",
    ],
    digimon: [
      "card_type", "colours", "level", "play_cost", "use_cost", "dp",
      "form", "attribute", "traits", "digivolution_requirements",
      "text_sections", "dual_colours", "dual_cost", "link_dp",
    ],
    gundam: [
      "card_type", "colours", "level", "cost", "block_icon",
      "effect_text", "zone", "traits", "link_condition", "ap", "hp",
      "series_titles",
    ],
  };
  assertOnlyFields(detail, fields[game]);
  if (Object.keys(detail).length === 0) {
    throw new Error(`Official ${game} Card detail is empty.`);
  }
  return { card: { ...detail } };
}

function parseOfficialLegalityNotice(
  value: unknown,
  contract: OfficialSourceContract,
): Record<string, unknown> {
  const record = requiredRecord(value, "Official legality notice");
  assertOnlyFields(record, [
    "source_id",
    "source_url",
    "notice_id",
    "official_text",
    "scope",
    "affected_card_numbers",
    "action",
    "representable",
  ]);
  if (
    typeof record.source_id !== "string" ||
    typeof record.source_url !== "string" ||
    typeof record.notice_id !== "string" ||
    typeof record.official_text !== "string" ||
    !Array.isArray(record.affected_card_numbers)
  ) {
    throw new Error("Official legality notice identity and wording are required.");
  }
  assertOfficialSourceUrl(record.source_url, contract);
  const scope = requiredRecord(record.scope, "Official legality notice scope");
  assertOnlyFields(scope, [
    "region", "format", "event_tier", "effective_from", "effective_until",
  ]);
  const action = requiredRecord(record.action, "Official legality notice action");
  validateNoticeWording(record.official_text, action);
  return {
    id: record.notice_id,
    game: contract.supportedGame,
    region: scope.region,
    format: scope.format,
    event_tier: scope.event_tier,
    effective_from: scope.effective_from,
    effective_until: scope.effective_until,
    card_numbers: record.affected_card_numbers,
    official_wording: record.official_text,
    effect: action,
    representable: record.representable,
  };
}

function validateNoticeWording(
  wording: string,
  action: Record<string, unknown>,
): void {
  const normalized = wording.normalize("NFC").toLowerCase();
  let detected: string | null = null;
  if (/no more than|maximum .*cop/.test(normalized)) detected = "copy_limit";
  else if (/same deck|combination|together/.test(normalized)) {
    detected = "prohibited_combination";
  } else if (/trait|colour|link condition|membership/.test(normalized)) {
    detected = "membership";
  } else if (/block|rotation/.test(normalized)) detected = "rotation";
  else if (/becomes? legal|release|available from/.test(normalized)) {
    detected = "release_timing";
  } else if (/does not identify|unresolved|clarification/.test(normalized)) {
    detected = "unresolved";
  } else if (/not legal|banned|may not be included|prohibited/.test(normalized)) {
    detected = "ban";
  } else if (/eligib(?:le|ility)/.test(normalized)) {
    detected = "eligible";
  }
  if (detected === null || action.type !== detected) {
    throw new Error(
      "Official legality notice wording is unknown or contradicts its structured action.",
    );
  }
}

function validateOfficialSurfaceRecords(
  name: string,
  records: readonly unknown[],
  contract: OfficialSourceContract,
): void {
  if (name === "legality_card_details" || name === "legality_rules") return;
  for (const recordValue of records) {
    const record = requiredRecord(
      recordValue,
      `${officialSurfaceLabel(name)} record`,
    );
    if (name === "discovery") {
      if (
        typeof record.surface !== "string" ||
        typeof record.request_id !== "string" ||
        record.surface === "discovery" ||
        !contract.requiredSurfaces.includes(record.surface) ||
        typeof record.url !== "string"
      ) {
        throw new Error(
        "Official Source discovery records must identify one request, required surface, and URL.",
        );
      }
      assertOfficialSourceUrl(record.url, contract);
      continue;
    }
    if (
      typeof record.source_id !== "string" ||
      record.source_id.length === 0 ||
      typeof record.source_url !== "string"
    ) {
      throw new Error(
        `${officialSurfaceLabel(name)} records require source_id and source_url provenance.`,
      );
    }
    assertOfficialSourceUrl(record.source_url, contract);
  }
}

export function assertOfficialSourceUrl(
  value: string,
  contract: OfficialSourceContract,
): URL {
  const url = new URL(value);
  if (
    url.origin !== contract.origin ||
    !url.pathname.startsWith(contract.pathnamePrefix) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `Official Source URL must be within ${contract.origin}${contract.pathnamePrefix}.`,
    );
  }
  return url;
}

function completeObservationEvidence() {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 1,
    parsed_record_count: 1,
  };
}

function requiredCount(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

function requiredRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(value).find(
    (field) => !allowed.has(field),
  );
  if (unexpected !== undefined) {
    throw new Error(
      `Official Source surface field ${unexpected} is unsupported.`,
    );
  }
}

export const sourceAdapterRegistrations: readonly SourceAdapterRegistration[] =
  Object.freeze(
    [
      {
        adapterVersion: "one-piece-official-errata-html@1",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "one-piece-official-errata-html@1",
        maximumSnapshotBytes: 1024 * 1024,
        origin: "production" as const,
        requestSurface: {
          kind: "exact-url" as const,
          url: "https://en.onepiece-cardgame.com/rules/errata_card/",
        },
        requiredSurfaces: ["errata"],
        requestUrlForSurface: (surface: string) => {
          if (surface !== "errata") {
            throw new Error("Official Errata surface identity is invalid.");
          }
          return "https://en.onepiece-cardgame.com/rules/errata_card/";
        },
        reconciliationCapability: "errata" as const,
        parseBytes: (bytes: Uint8Array) => {
          const document = new TextDecoder(
            "utf-8",
            { fatal: true, ignoreBOM: false },
          ).decode(bytes);
          return parseOnePieceOfficialErrataHtml(document);
        },
      },
      ...officialRawAdapterContracts.map((adapter) => ({
        adapterVersion: adapter.adapterVersion,
        sourceLineage: adapter.sourceLineage,
        supportedGame: adapter.supportedGame,
        gameProfileVersion: `${adapter.supportedGame}@1`,
        parserContract: `${adapter.sourceLineage}-raw-surfaces@1`,
        maximumSnapshotBytes: 16 * 1024 * 1024,
        origin: "production" as const,
        requestSurface: { kind: "credential-free-https" as const },
        reconciliationCapability: "catalogue" as const,
        parseBytes: adapter.parseBytes,
        discoverRequests: adapter.discoverRequests,
        requiredSurfaces: adapter.requiredSurfaces,
        requestUrlForSurface: adapter.requestUrlForSurface,
      })),
      ...[
        {
          adapterVersion: "one-piece-json-document@1",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "one-piece-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "one-piece-json-document@2",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "one-piece-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "fusion-world-en@1",
          sourceLineage: "fusion-world-en",
          supportedGame: "fusion-world",
          gameProfileVersion: "fusion-world@1",
          parserContract: "fusion-world-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "digimon-en@1",
          sourceLineage: "digimon-en",
          supportedGame: "digimon",
          gameProfileVersion: "digimon@1",
          parserContract: "digimon-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "gundam-en-asia@1",
          sourceLineage: "gundam-en-asia",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "gundam-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "gundam-en-us@1",
          sourceLineage: "gundam-en-us",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "gundam-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
      ].map((adapter) => ({
        ...adapter,
        origin: "production" as const,
        requestSurface: { kind: "credential-free-https" as const },
        reconciliationCapability: "unavailable" as const,
      })),
      {
        adapterVersion: "fixture-one-piece-official-errata-json@1",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "synthetic-official-errata-fixture@1",
        maximumSnapshotBytes: 16 * 1024 * 1024,
        origin: "synthetic_fixture" as const,
        requestSurface: { kind: "synthetic-fixture" as const },
        reconciliationCapability: "errata" as const,
        parse: parseSourceDocument,
      },
      {
        adapterVersion: "gundam-en-asia@2",
        sourceLineage: "gundam-en-asia",
        supportedGame: "gundam",
        gameProfileVersion: "gundam@1",
        parserContract: "gundam-official-legality@5",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "official_legality" as const,
        officialSourceContract: gundamAsiaOfficialSource,
        parse: gundamOfficialLegalityParser(gundamAsiaOfficialSource),
      },
      {
        adapterVersion: "gundam-en-us@2",
        sourceLineage: "gundam-en-us",
        supportedGame: "gundam",
        gameProfileVersion: "gundam@1",
        parserContract: "gundam-official-legality@5",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "official_legality" as const,
        officialSourceContract: gundamUsOfficialSource,
        parse: gundamOfficialLegalityParser(gundamUsOfficialSource),
      },
      ...[
        {
          adapterVersion: "fixture-one-piece-json@1",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-one-piece-json@2",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-one-piece-json-capped@1",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
        },
        {
          adapterVersion: "fixture-fusion-world-json@1",
          sourceLineage: "fusion-world-en",
          supportedGame: "fusion-world",
          gameProfileVersion: "fusion-world@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-digimon-json@1",
          sourceLineage: "digimon-en",
          supportedGame: "digimon",
          gameProfileVersion: "digimon@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-gundam-en-asia-json@1",
          sourceLineage: "gundam-en-asia",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-gundam-en-us-json@1",
          sourceLineage: "gundam-en-us",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
      ].map((adapter) => ({
        ...adapter,
        maximumSnapshotBytes:
          adapter.maximumSnapshotBytes ?? 16 * 1024 * 1024,
        origin: "synthetic_fixture" as const,
        requestSurface: { kind: "synthetic-fixture" as const },
        reconciliationCapability: "catalogue" as const,
        parse: parseSourceDocument,
      })),
    ].map((adapter) => Object.freeze(adapter)),
  );

const installedAdapters = new Map<string, SourceAdapterRegistration>(
  sourceAdapterRegistrations.map((adapter) => [
    adapter.adapterVersion,
    adapter,
  ]),
);

export function requiredSourceAdapter(
  adapterVersion: string,
): SourceAdapterRegistration {
  const adapter = installedAdapters.get(adapterVersion);
  if (adapter === undefined) {
    throw new AdministrationProblem(
      422,
      "adapter_not_supported",
      "The requested Official Source adapter version is not installed.",
    );
  }
  return adapter;
}

export function assertAdapterBinding(
  adapter: SourceAdapterRegistration,
  input: {
    sourceLineage: string;
    supportedGame: string;
    gameProfileVersion?: string;
  },
): void {
  if (
    adapter.sourceLineage !== input.sourceLineage ||
    adapter.supportedGame !== input.supportedGame ||
    (input.gameProfileVersion !== undefined &&
      adapter.gameProfileVersion !== input.gameProfileVersion)
  ) {
    throw new AdministrationProblem(
      422,
      "adapter_binding_mismatch",
      "The adapter version is not registered for this Supported Game, Game Profile, and Official Source lineage.",
    );
  }
}

export function assertAdapterRequestSurface(
  adapter: SourceAdapterRegistration,
  url: URL,
): void {
  const surface = adapter.requestSurface;
  if (surface.kind !== "exact-url" || url.href === surface.url) return;
  throw new AdministrationProblem(
    422,
    "official_source_surface_mismatch",
    `The Official Errata adapter accepts only ${surface.url}.`,
  );
}
