/** Domain code can compose atomic batches; SQL preparation stays in repositories. */
const catalogueStoreBrand: unique symbol = Symbol("CatalogueStore");

export interface CatalogueStore {
  readonly [catalogueStoreBrand]: true;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

const stores = new WeakMap<D1Database, CatalogueStore>();
const bindings = new WeakMap<CatalogueStore, D1Database>();

/** Adapt a Worker binding once at the composition boundary. */
export function catalogueStore(database: D1Database): CatalogueStore {
  const existing = stores.get(database);
  if (existing !== undefined) return existing;
  const store: CatalogueStore = {
    [catalogueStoreBrand]: true,
    batch: <T = unknown>(statements: D1PreparedStatement[]) => database.batch<T>(statements),
  };
  stores.set(database, store);
  bindings.set(store, database);
  return store;
}

/** Repository-only capability; the domain port never exposes the raw binding. */
export function repositoryStatements(store: CatalogueStore): Pick<D1Database, "prepare"> {
  const database = bindings.get(store);
  if (database === undefined) throw new TypeError("A CatalogueStore must be created from a database binding.");
  return database;
}

/** Preserve inherited and lazily supplied bindings while adapting the catalogue capability. */
export function catalogueEnvironment<Environment extends { CATALOGUE_DB: D1Database }>(
  environment: Environment,
): Omit<Environment, "CATALOGUE_DB"> & { CATALOGUE_DB: CatalogueStore } {
  return Object.create(environment, {
    CATALOGUE_DB: { value: catalogueStore(environment.CATALOGUE_DB), enumerable: true },
  }) as Omit<Environment, "CATALOGUE_DB"> & { CATALOGUE_DB: CatalogueStore };
}
