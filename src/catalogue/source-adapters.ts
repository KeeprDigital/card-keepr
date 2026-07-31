import { AdministrationProblem } from "./administration-problem.mjs";
import {
  officialRawAdapterContracts,
} from "./official-raw-adapter-contracts.mjs";
import { parseOnePieceOfficialErrataHtml } from "./one-piece-official-errata-html.mjs";

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

function officialLegalityParser(
  contract: OfficialSourceContract,
): (document: unknown) => readonly unknown[] {
  return (document) => {
    const envelope = requiredRecord(
      document,
      "Official Source surface document",
    );
    assertOnlyFields(envelope, ["surface"]);
    const surface = requiredRecord(
      envelope.surface,
      "Official Source surface",
    );
    if (
      typeof surface.name !== "string" ||
      !contract.requiredSurfaces.includes(surface.name)
    ) {
      throw new Error(
        "The Official Source response does not identify one required surface.",
      );
    }
    const name = surface.name;
    const records = parseOfficialSurface(
      surface,
      officialSurfaceLabel(name),
      contract,
      name === "legality_rules" || name === "legality_card_details",
    );
    validateOfficialSurfaceRecords(name, records, contract);
    const retainedSurfaceEvidence = {
      observation_type: "official_surface_evidence",
      surface: name,
      records,
      completeness: completeObservationEvidence(),
    };
    if (name === "legality_card_details") {
      return [
        retainedSurfaceEvidence,
        ...records.map((card) =>
          parseOfficialLegalityCardDetail(card, contract)
        ),
      ];
    }
    if (name !== "legality_rules") {
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

function parseOfficialSurface(
  value: unknown,
  name: string,
  contract: OfficialSourceContract,
  allowEmpty: boolean,
): unknown[] {
  const surface = requiredRecord(value, `${name} surface`);
  assertOnlyFields(surface, [
    "name",
    "partition",
    "declared_record_count",
    "pages",
  ]);
  if (surface.partition !== contract.partition) {
    throw new Error(
      `${name} surface partition does not match its Source Lineage.`,
    );
  }
  const declaredRecordCount = requiredCount(
    surface.declared_record_count,
    `${name} surface declared record count`,
  );
  if (!Array.isArray(surface.pages)) {
    throw new Error(`${name} surface pages must be an array.`);
  }
  if (declaredRecordCount > 0 && surface.pages.length === 0) {
    throw new Error(
      `${name} surface declared records but retained no pages.`,
    );
  }
  const records: unknown[] = [];
  const totalPages = surface.pages.length;
  for (const [index, valuePage] of surface.pages.entries()) {
    const page = requiredRecord(valuePage, `${name} surface page`);
    assertOnlyFields(page, [
      "number",
      "total_pages",
      "declared_record_count",
      "records",
    ]);
    if (
      page.number !== index + 1 ||
      page.total_pages !== totalPages
    ) {
      throw new Error(
        `${name} surface pages do not prove an exact complete partition.`,
      );
    }
    if (!Array.isArray(page.records)) {
      throw new Error(`${name} surface page records must be an array.`);
    }
    const pageDeclaredCount = requiredCount(
      page.declared_record_count,
      `${name} surface page declared record count`,
    );
    if (pageDeclaredCount !== page.records.length) {
      throw new Error(
        `${name} surface declared and parsed record counts differ.`,
      );
    }
    records.push(...page.records);
  }
  if (records.length !== declaredRecordCount) {
    throw new Error(
      `${name} surface declared and parsed record counts differ.`,
    );
  }
  if (!allowEmpty && records.length === 0) {
    throw new Error(
      `${name} surface cannot prove live Official Source coverage with no records.`,
    );
  }
  return records;
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
  else if (/becomes legal|release|available from/.test(normalized)) {
    detected = "release_timing";
  } else if (/does not identify|unresolved|clarification/.test(normalized)) {
    detected = "unresolved";
  } else if (/not legal|banned|may not be included|prohibited/.test(normalized)) {
    detected = "ban";
  } else if (
    /eligib(?:le|ility)|ordering fixture|serialization golden/.test(normalized)
  ) {
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
        parserContract: "gundam-official-legality@4",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "official_legality" as const,
        officialSourceContract: gundamAsiaOfficialSource,
        parse: officialLegalityParser(gundamAsiaOfficialSource),
      },
      {
        adapterVersion: "gundam-en-us@2",
        sourceLineage: "gundam-en-us",
        supportedGame: "gundam",
        gameProfileVersion: "gundam@1",
        parserContract: "gundam-official-legality@4",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "official_legality" as const,
        officialSourceContract: gundamUsOfficialSource,
        parse: officialLegalityParser(gundamUsOfficialSource),
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
