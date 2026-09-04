import { currentCatalogueStatus } from "../../src/catalogue/read";
import { type CatalogueStore } from "../../src/catalogue/shared";

// Checked by tsc, never executed: the domain cannot accept or unwrap a raw binding.
export function catalogueStoreTypeContract(store: CatalogueStore, binding: D1Database): void {
  void currentCatalogueStatus(store);
  // @ts-expect-error Domain entrypoints require the adapted port.
  void currentCatalogueStatus(binding);
  // @ts-expect-error SQL preparation belongs to repository factories.
  store.prepare("SELECT 1");
  // @ts-expect-error Domain code cannot bypass atomic statements with arbitrary SQL execution.
  store.exec("SELECT 1");
}
