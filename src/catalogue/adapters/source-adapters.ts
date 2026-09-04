import { AdministrationProblem } from "../shared";
import { AdapterParseFailure, adapterUrl } from "./adapter-parse-failure";
import { requiredOfficialSourceScope } from "./official-source-scope.ts";
import { parseOnePieceOfficialErrataHtml } from "./one-piece-official-errata-html.ts";
import { officialRawAdapterContracts } from "./product-release-source-adapters.ts";
import type { ListingReconciliationTraits } from "./source-adapter-registration-types.ts";

export type OfficialSourceContract = Readonly<{
  supportedGame: "one-piece" | "fusion-world" | "digimon" | "gundam";
  partition: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
  origin: string;
  documentPathnamePrefixes: readonly string[];
  imagePathnamePrefixes: readonly string[];
  requiredSurfaces: readonly string[];
}>;

export type SourceAdapterRegistration = Readonly<{
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: string;
  legalityRegion: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
  gameProfileVersion: string;
  parserContract: string;
  maximumSnapshotBytes: number;
  requestCapacity: number;
  origin: "production" | "synthetic_fixture";
  requestSurface:
    | Readonly<{ kind: "credential-free-https" }>
    | Readonly<{ kind: "exact-url"; url: string }>
    | Readonly<{ kind: "synthetic-fixture" }>;
  reconciliationCapability: "catalogue" | "errata" | "unavailable";
  reconciliationAreas?: readonly ("catalogue" | "errata")[];
  inheritDiscoveryRequestHeaders?: boolean;
  listingReconciliation?: ListingReconciliationTraits;
  parse?: (document: unknown) => readonly unknown[] | Promise<readonly unknown[]>;
  parseBytes?: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  discoverRequests?: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly {
    role: "listing" | "detail" | "product_detail" | "image";
    discoveryKey?: string;
    url: string;
    headers: Record<string, string>;
  }[];
  requiredSurfaces?: readonly string[];
  requestUrlForDiscovery?: () => string;
  requestUrlForSurface?: (surface: string) => string;
  officialSourceContract?: OfficialSourceContract;
}>;

// No ordinary Source Adapter Version capacity may authorize discovery at or
// beyond this ceiling. Registration fails closed on a declared capacity that
// reaches it, and capacity admission additionally clamps the registered
// database column to it, so neither surface can authorize unbounded
// discovery alone.
export const globalEmergencySourceRequestCeiling = 25_000;

// Request capacity is a policy of each exact Source Adapter Version, counted
// per Source Lineage over unique Source Request identities. Versions without
// a declared capacity keep the historical 5,000-request behavior. Before
// Go-Live (ADR 0008) a capacity is edited in place, here and in the
// source_adapter_versions seed rows in migrations/0001_baseline.sql; from
// Go-Live it is immutable and a larger capacity requires a new version.
const historicalSourceRequestCapacity = 5_000;
const declaredSourceRequestCapacities: ReadonlyMap<string, number> = new Map([
  // The first production One Piece run of 2026-09-03 discovered 4,699
  // requests and paused at the historical 5,000 bound (issue #134).
  ["one-piece-en@6", 10_000],
  // The production Fusion World graph legitimately exceeds the historical
  // bound (issue #62 retained 3,946 detail and 984 image requests at the
  // 5,000 cutoff before completion).
  ["fusion-world-en@9", 15_000],
]);

function sourceRequestCapacity(adapterVersion: string): number {
  const capacity = declaredSourceRequestCapacities.get(adapterVersion) ?? historicalSourceRequestCapacity;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity >= globalEmergencySourceRequestCeiling) {
    throw new AdapterParseFailure(
      `Source Adapter Version ${adapterVersion} declares a request capacity outside the global emergency ceiling.`,
      { category: "configuration" },
    );
  }
  return capacity;
}

export function requiredOfficialSourceContract(adapter: SourceAdapterRegistration): OfficialSourceContract {
  if (adapter.reconciliationCapability !== "catalogue" || adapter.officialSourceContract === undefined) {
    throw new AdapterParseFailure(`Adapter ${adapter.adapterVersion} has no complete Official Source contract.`, {
      category: "configuration",
    });
  }
  return adapter.officialSourceContract;
}

export function assertOfficialSourceUrl(value: string, contract: OfficialSourceContract): URL {
  const url = adapterUrl(value);
  if (
    url.origin !== contract.origin ||
    !contract.documentPathnamePrefixes.some((prefix) => url.pathname.startsWith(prefix)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new AdapterParseFailure(
      `Official Source URL is outside the exact path authority registered for ${contract.origin}.`,
    );
  }
  return url;
}

// The registration facts every production raw-catalogue version shares.
function productionCatalogueRegistration(
  adapter: Readonly<{
    adapterVersion: string;
    sourceLineage: string;
    supportedGame: string;
    parserContract: string;
    reconciliationAreas: readonly ("catalogue" | "errata")[];
    inheritDiscoveryRequestHeaders: boolean;
  }>,
) {
  return {
    adapterVersion: adapter.adapterVersion,
    sourceLineage: adapter.sourceLineage,
    supportedGame: adapter.supportedGame,
    gameProfileVersion: `${adapter.supportedGame}@1`,
    parserContract: adapter.parserContract,
    maximumSnapshotBytes: 16 * 1024 * 1024,
    origin: "production" as const,
    requestSurface: { kind: "credential-free-https" as const },
    reconciliationCapability: "catalogue" as const,
    reconciliationAreas: adapter.reconciliationAreas,
    inheritDiscoveryRequestHeaders: adapter.inheritDiscoveryRequestHeaders,
  };
}

export const installedSourceAdapterRegistrations: readonly SourceAdapterRegistration[] = Object.freeze(
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
          throw new AdapterParseFailure("Official Errata surface identity is invalid.", { category: "configuration" });
        }
        return "https://en.onepiece-cardgame.com/rules/errata_card/";
      },
      reconciliationCapability: "errata" as const,
      parseBytes: (bytes: Uint8Array) => {
        let document: string;
        try {
          document = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
        } catch (error) {
          throw new AdapterParseFailure(
            error instanceof Error ? error.message : "Official Errata bytes are not valid UTF-8.",
            { cause: error },
          );
        }
        return parseOnePieceOfficialErrataHtml(document);
      },
    },
    ...officialRawAdapterContracts.map((adapter) => ({
      ...productionCatalogueRegistration(adapter),
      listingReconciliation: adapter.listingReconciliation,
      parseBytes: (bytes: Uint8Array, context: { mediaType: string | null; url: string; requestId?: string }) =>
        adapter.parse(context, bytes),
      discoverRequests: adapter.discoverRequests,
      requiredSurfaces: adapter.requiredSurfaces,
      requestUrlForDiscovery: adapter.requestUrlForDiscovery,
      requestUrlForSurface: adapter.requestUrlForSurface,
      officialSourceContract: {
        supportedGame: adapter.supportedGame,
        partition: adapter.partition,
        origin: adapter.sourceOrigin,
        documentPathnamePrefixes: adapter.documentPathnamePrefixes,
        imagePathnamePrefixes: adapter.imagePathnamePrefixes,
        requiredSurfaces: adapter.requiredSurfaces,
      },
    })),
  ].map((adapter) =>
    Object.freeze({
      ...adapter,
      legalityRegion: requiredOfficialSourceScope(adapter.sourceLineage).legalityRegion,
      requestCapacity: sourceRequestCapacity(adapter.adapterVersion),
    }),
  ),
);

const activeOfficialRawAdapterVersions = new Set([
  ...new Map(officialRawAdapterContracts.map((adapter) => [adapter.sourceLineage, adapter.adapterVersion])).values(),
]);

// Registrations that may start new collection: everything installed except
// any superseded (predecessor) raw contract. Before Go-Live (ADR 0008) no
// predecessor is registered, so this equals the installed set.
export const sourceAdapterRegistrations: readonly SourceAdapterRegistration[] = Object.freeze(
  installedSourceAdapterRegistrations.filter(
    (adapter) =>
      adapter.origin !== "production" ||
      adapter.reconciliationCapability !== "catalogue" ||
      typeof adapter.parseBytes !== "function" ||
      activeOfficialRawAdapterVersions.has(adapter.adapterVersion),
  ),
);

const installedAdapters = new Map<string, SourceAdapterRegistration>(
  installedSourceAdapterRegistrations.map((adapter) => [adapter.adapterVersion, adapter]),
);

const activeAdapters = new Map<string, SourceAdapterRegistration>(
  sourceAdapterRegistrations
    .filter((adapter) => adapter.reconciliationCapability !== "unavailable")
    .map((adapter) => [adapter.adapterVersion, adapter]),
);

/** Additional registrations are installed only by the test composition root.
 * Shipped entrypoints use the immutable registry above and never call this seam.
 */
export function registerSourceAdapters(registrations: readonly SourceAdapterRegistration[]): void {
  const registered = new Set(installedAdapters.keys());
  for (const adapter of registrations) {
    if (registered.has(adapter.adapterVersion))
      throw new Error(`Source Adapter Version ${adapter.adapterVersion} is already registered.`);
    if (
      !Number.isSafeInteger(adapter.requestCapacity) ||
      adapter.requestCapacity < 1 ||
      adapter.requestCapacity >= globalEmergencySourceRequestCeiling
    ) {
      throw new Error("Source Adapter Version request capacity is invalid.");
    }
    registered.add(adapter.adapterVersion);
  }
  for (const adapter of registrations) {
    const registration = Object.freeze({ ...adapter });
    installedAdapters.set(adapter.adapterVersion, registration);
    if (adapter.reconciliationCapability !== "unavailable") activeAdapters.set(adapter.adapterVersion, registration);
  }
}

export function requiredSourceAdapter(adapterVersion: string): SourceAdapterRegistration {
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

export function adapterReconciliationAreas(adapter: SourceAdapterRegistration): readonly ("catalogue" | "errata")[] {
  if (adapter.reconciliationAreas !== undefined) {
    return adapter.reconciliationAreas;
  }
  return adapter.reconciliationCapability === "unavailable" ? [] : [adapter.reconciliationCapability];
}

export function requiredActiveSourceAdapter(adapterVersion: string): SourceAdapterRegistration {
  const adapter = activeAdapters.get(adapterVersion);
  if (adapter === undefined) {
    throw new AdministrationProblem(
      422,
      "adapter_not_supported",
      "The requested Official Source adapter version is not active for new collection.",
    );
  }
  return adapter;
}

export function registeredLegalitySourceScope(sourceLineage: string): {
  game: "one-piece" | "fusion-world" | "digimon" | "gundam";
  region: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
} {
  const registrations = installedSourceAdapterRegistrations.filter(
    (adapter) => adapter.sourceLineage === sourceLineage,
  );
  const first = registrations[0];
  if (
    first === undefined ||
    !["one-piece", "fusion-world", "digimon", "gundam"].includes(first.supportedGame) ||
    registrations.some(
      (adapter) => adapter.supportedGame !== first.supportedGame || adapter.legalityRegion !== first.legalityRegion,
    )
  ) {
    throw new AdapterParseFailure("Legality Source Lineage has no consistent registered ownership.", {
      category: "configuration",
    });
  }
  return {
    game: first.supportedGame as "one-piece" | "fusion-world" | "digimon" | "gundam",
    region: first.legalityRegion,
  };
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
    (input.gameProfileVersion !== undefined && adapter.gameProfileVersion !== input.gameProfileVersion)
  ) {
    throw new AdministrationProblem(
      422,
      "adapter_binding_mismatch",
      "The adapter version is not registered for this Supported Game, Game Profile, and Official Source lineage.",
    );
  }
}

export function assertAdapterRequestSurface(adapter: SourceAdapterRegistration, url: URL): void {
  const surface = adapter.requestSurface;
  if (surface.kind !== "exact-url" || url.href === surface.url) return;
  throw new AdministrationProblem(
    422,
    "official_source_surface_mismatch",
    `The Official Errata adapter accepts only ${surface.url}.`,
  );
}
