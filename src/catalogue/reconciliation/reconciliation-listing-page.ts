import { requiredSourceAdapter } from "../adapters";
import { canonicalJson } from "../shared";

export type GundamListingPage = {
  requestId: string;
  sourceLineage: string;
  package: string | null;
  page: number;
  terminal: boolean;
  declaredTotal: number;
  fullLocators: string[];
};

export type GundamListingCollectionGraphInput = Readonly<{
  requestId: string;
  requestUrl: string;
  sourceLineage: string;
  adapterVersion: string;
  observations: readonly unknown[];
}>;

export function validateGundamListingCollectionGraph(inputs: readonly GundamListingCollectionGraphInput[]): {
  completeRequestIds: string[];
  collections: {
    sourceLineage: string;
    package: string | null;
    declaredTotal: number;
    terminalPage: number;
    fullLocators: string[];
  }[];
} {
  const grouped = new Map<string, GundamListingPage[]>();
  for (const input of inputs) {
    const page = gundamListingPage(input);
    if (!page) continue;
    const key = canonicalJson([page.sourceLineage, page.package]);
    grouped.set(key, [...(grouped.get(key) ?? []), page]);
  }
  const completeRequestIds = new Set<string>();
  const collections = [...grouped.values()]
    .map((pages) => {
      const ordered = [...pages].sort((left, right) => left.page - right.page);
      const pageNumbers = new Set(ordered.map(({ page }) => page));
      const terminal = ordered.filter(({ terminal }) => terminal);
      const lastPage = ordered.at(-1)!.page;
      if (
        pageNumbers.size !== ordered.length ||
        ordered[0]!.page !== 1 ||
        terminal.length !== 1 ||
        terminal[0]!.page !== lastPage ||
        ordered.some(({ page }, index) => page !== index + 1)
      ) {
        throw new Error("A retained Gundam listing collection has incomplete page continuity or terminal-page proof.");
      }
      const declaredTotals = new Set(ordered.map(({ declaredTotal }) => declaredTotal));
      if (declaredTotals.size !== 1) {
        throw new Error("A retained Gundam listing collection disagrees on its publisher total.");
      }
      const declaredTotal = ordered[0]!.declaredTotal;
      const fullLocators = [...new Set(ordered.flatMap(({ fullLocators }) => fullLocators))].sort();
      if (fullLocators.length !== declaredTotal) {
        throw new Error("A retained Gundam listing collection does not close its publisher total across pages.");
      }
      for (const { requestId } of ordered) completeRequestIds.add(requestId);
      return {
        sourceLineage: ordered[0]!.sourceLineage,
        package: ordered[0]!.package,
        declaredTotal,
        terminalPage: lastPage,
        fullLocators,
      };
    })
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    completeRequestIds: [...completeRequestIds].sort(),
    collections,
  };
}

export function gundamListingPage(input: GundamListingCollectionGraphInput): GundamListingPage | null {
  if (requiredSourceAdapter(input.adapterVersion).listingReconciliation?.groupsPublisherPages !== true) return null;
  const retained = input.observations.flatMap((wrapped) => {
    const observation = isRecord(wrapped) && isRecord(wrapped.value) ? wrapped.value : wrapped;
    if (!isRecord(observation) || !isRecord(observation.source_sidecar)) {
      return [];
    }
    const raw = observation.source_sidecar.raw;
    if (!isRecord(raw) || !Array.isArray(raw.official_surfaces)) return [];
    return raw.official_surfaces.flatMap((surface) => {
      if (
        !isRecord(surface) ||
        surface.source_lineage !== input.sourceLineage ||
        surface.surface !== "listing" ||
        !isRecord(surface.document) ||
        !("terminal_page" in surface.document)
      )
        return [];
      return [{ observation, document: surface.document }];
    });
  });
  if (retained.length === 0) return null;
  if (retained.length !== 1) {
    throw new Error("A Gundam listing request retained duplicate collection proofs.");
  }
  const { observation, document } = retained[0]!;
  const selectedPackage = document.selected_package;
  const selectedPage = document.selected_page;
  const declaredTotal = document.declared_total;
  const fullLocators = document.full_locators;
  if (
    (selectedPackage !== null && (typeof selectedPackage !== "string" || selectedPackage.length === 0)) ||
    !Number.isSafeInteger(selectedPage) ||
    Number(selectedPage) < 1 ||
    !Number.isSafeInteger(declaredTotal) ||
    Number(declaredTotal) < 0 ||
    !Array.isArray(fullLocators) ||
    !fullLocators.every((locator) => typeof locator === "string" && locator.length > 0) ||
    new Set(fullLocators).size !== fullLocators.length ||
    typeof document.terminal_page !== "boolean"
  ) {
    throw new Error("A retained Gundam listing collection proof is invalid.");
  }
  const url = new URL(input.requestUrl);
  const requestedPackages = url.searchParams.getAll("package");
  const requestedPages = url.searchParams.getAll("page");
  const requestedPackage = requestedPackages[0] ?? null;
  const requestedPage = Number.parseInt(requestedPages[0] ?? "1", 10);
  if (
    requestedPackages.length > 1 ||
    requestedPages.length > 1 ||
    requestedPackage !== selectedPackage ||
    requestedPage !== selectedPage
  ) {
    throw new Error("A retained Gundam listing collection proof conflicts with its request identity.");
  }
  const completeness = observation.completeness;
  const individuallyComplete = document.terminal_page === true && fullLocators.length === declaredTotal;
  if (
    !isRecord(completeness) ||
    completeness.structurally_complete !== true ||
    completeness.declared_record_count !== declaredTotal ||
    completeness.parsed_record_count !== fullLocators.length ||
    completeness.required_surfaces_complete !== individuallyComplete ||
    completeness.partitions_complete !== individuallyComplete
  ) {
    throw new Error("A retained Gundam listing page overstates its individual completeness.");
  }
  return {
    requestId: input.requestId,
    sourceLineage: input.sourceLineage,
    package: selectedPackage,
    page: Number(selectedPage),
    terminal: document.terminal_page,
    declaredTotal: Number(declaredTotal),
    fullLocators: fullLocators as string[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
