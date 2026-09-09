import type { CatalogueCandidate } from "./catalogue-candidate-types";

export const catalogueEntityCollections = [
  "cards",
  "printings",
  "printing_images",
  "products",
  "distribution_contexts",
  "product_relationships",
  "errata",
  "identity_corrections",
] as const;
export type CatalogueEntityCollection = (typeof catalogueEntityCollections)[number];
export type CatalogueDraftEntity<K extends CatalogueEntityCollection> = NonNullable<CatalogueCandidate[K]>[number];

/** A mutable preparation view. Iteration is ordered by entity ID and retains one entity at a time. */
export interface CatalogueDraft {
  get<K extends CatalogueEntityCollection>(kind: K, id: string): Promise<CatalogueDraftEntity<K> | undefined>;
  has(kind: CatalogueEntityCollection, id: string): Promise<boolean>;
  set<K extends CatalogueEntityCollection>(kind: K, entity: CatalogueDraftEntity<K>): Promise<void>;
  delete(kind: CatalogueEntityCollection, id: string): Promise<void>;
  values<K extends CatalogueEntityCollection>(kind: K, after?: string): AsyncIterable<CatalogueDraftEntity<K>>;
}
