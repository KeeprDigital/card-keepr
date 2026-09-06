import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { gundamListingPage, type GundamListingCollectionGraphInput } from "./reconciliation-listing-page";

type Collection = {
  id: string;
  first: number;
  last: number;
  pages: number;
  duplicatePage: boolean;
  terminalPages: number;
  terminalPage: number | null;
  declaredTotal: number;
  totalMismatch: boolean;
  locators: number;
};

/** Publisher pagination closes through retained counters and individual locator identities. */
export class ReconciliationGundamGraph {
  private collections: ReconciliationReducerIndex<Collection>;
  private pages: ReconciliationReducerIndex<boolean>;
  private requests: ReconciliationReducerIndex<boolean>;
  private locatorIndex: ReconciliationReducerIndex<{ id: string; sourceLineage: string; locator: string }>;
  private header: ReconciliationReducerIndex<boolean>;
  private requestCount = 0;
  private validated = false;
  constructor(database: CatalogueStore, runId: string) {
    this.collections = new ReconciliationReducerIndex(database, runId, "gundam_graph_collections");
    this.pages = new ReconciliationReducerIndex(database, runId, "gundam_graph_pages");
    this.requests = new ReconciliationReducerIndex(database, runId, "gundam_graph_requests");
    this.locatorIndex = new ReconciliationReducerIndex(database, runId, "gundam_graph_locators");
    this.header = new ReconciliationReducerIndex(database, runId, "gundam_graph_header");
  }
  async add(input: GundamListingCollectionGraphInput): Promise<void> {
    if (this.validated) throw new Error("Cannot append to a validated Gundam listing graph.");
    const page = gundamListingPage(input);
    if (!page) return;
    const id = await sha256Text(canonicalJson([page.sourceLineage, page.package]));
    const prior = await this.collections.get(id);
    const pageKey = canonicalJson([id, page.page]);
    const duplicatePage = await this.pages.has(pageKey);
    await this.pages.seed(pageKey, true);
    let locators = prior?.locators ?? 0;
    for (const locator of page.fullLocators) {
      const key = await sha256Text(canonicalJson([id, locator]));
      if (!(await this.locatorIndex.has(key))) {
        await this.locatorIndex.seed(key, { id: key, sourceLineage: page.sourceLineage, locator });
        locators++;
      }
    }
    await this.collections.seed(id, {
      id,
      first: Math.min(prior?.first ?? page.page, page.page),
      last: Math.max(prior?.last ?? page.page, page.page),
      pages: (prior?.pages ?? 0) + 1,
      duplicatePage: (prior?.duplicatePage ?? false) || duplicatePage,
      terminalPages: (prior?.terminalPages ?? 0) + Number(page.terminal),
      terminalPage: page.terminal ? page.page : (prior?.terminalPage ?? null),
      declaredTotal: prior?.declaredTotal ?? page.declaredTotal,
      totalMismatch:
        (prior?.totalMismatch ?? false) || (prior !== undefined && prior.declaredTotal !== page.declaredTotal),
      locators,
    });
    await this.requests.seed(page.requestId, true);
    this.requestCount++;
  }
  async validate(): Promise<void> {
    for await (const group of this.collections.entityValues()) {
      if (
        group.first !== 1 ||
        group.pages !== group.last ||
        group.duplicatePage ||
        group.terminalPages !== 1 ||
        group.terminalPage !== group.last
      )
        throw new Error("A retained Gundam listing collection has incomplete page continuity or terminal-page proof.");
      if (group.totalMismatch)
        throw new Error("A retained Gundam listing collection disagrees on its publisher total.");
      if (group.locators !== group.declaredTotal)
        throw new Error("A retained Gundam listing collection does not close its publisher total across pages.");
    }
    await this.header.seed("validated", true);
    this.validated = true;
  }
  async hasCompleteRequest(id: string): Promise<boolean> {
    if (!this.validated) throw new Error("The Gundam listing graph is not validated.");
    return this.requestCount > 0 && (await this.requests.has(id));
  }
  locators() {
    return this.locatorIndex.entityValues();
  }
}
