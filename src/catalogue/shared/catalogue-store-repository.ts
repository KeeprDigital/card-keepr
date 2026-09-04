/** Domain code can compose atomic batches; SQL preparation stays in repositories. */
const catalogueStoreBrand: unique symbol = Symbol("CatalogueStore");

export interface CatalogueStore {
  readonly [catalogueStoreBrand]: true;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

const stores = new WeakMap<D1Database, CatalogueStore>();
const bindings = new WeakMap<CatalogueStore, D1Database>();
const atomicStatements = new WeakMap<D1PreparedStatement, AtomicRepositoryStatement>();

type AtomicRepositoryStatement = Readonly<{
  store: CatalogueStore;
  statement: D1PreparedStatement;
  before: readonly D1PreparedStatement[];
  after: readonly D1PreparedStatement[];
}>;

/** Adapt a Worker binding once at the composition boundary. */
export function catalogueStore(database: D1Database): CatalogueStore {
  const existing = stores.get(database);
  if (existing !== undefined) return existing;
  const store: CatalogueStore = {
    [catalogueStoreBrand]: true,
    batch: <T = unknown>(statements: D1PreparedStatement[]) => atomicBatch<T>(store, database, statements),
  };
  stores.set(database, store);
  bindings.set(store, database);
  return store;
}

/**
 * Repository-only, already-bound mutation recipe. Guards and side effects join
 * the caller's native transaction, while its primary result keeps its position.
 * Bind each statement before grouping; rebinding and raw column access are not
 * part of this closed mutation contract.
 */
export function atomicRepositoryStatement(
  store: CatalogueStore,
  input: Readonly<{
    statement: D1PreparedStatement;
    before?: readonly D1PreparedStatement[];
    after?: readonly D1PreparedStatement[];
  }>,
): D1PreparedStatement {
  const execute = async <T>(): Promise<D1Result<T>> => {
    const result = (await store.batch<T>([statement]))[0];
    if (result === undefined) throw new Error("D1 did not return the atomic mutation result.");
    return result;
  };
  const statement: D1PreparedStatement = {
    bind() {
      throw new TypeError("Bind repository statements before composing an atomic mutation.");
    },
    run: execute,
    all: execute,
    async first<T>(column?: string): Promise<T | null> {
      const result = await execute<Record<string, unknown>>();
      const row = result.results[0];
      if (row === undefined) return null;
      if (column === undefined) return row as T;
      if (!Object.hasOwn(row, column)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found: ${column}`);
      return row[column] as T;
    },
    async raw(): Promise<never> {
      throw new TypeError("Atomic repository mutations expose named results, not raw column arrays.");
    },
  };
  atomicStatements.set(statement, {
    store,
    statement: input.statement,
    before: [...(input.before ?? [])],
    after: [...(input.after ?? [])],
  });
  return statement;
}

async function atomicBatch<T>(
  store: CatalogueStore,
  database: D1Database,
  statements: readonly D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  const expanded: D1PreparedStatement[] = [];
  const append = (statement: D1PreparedStatement): number => {
    const group = atomicStatements.get(statement);
    if (group === undefined) {
      expanded.push(statement);
      return expanded.length - 1;
    }
    if (group.store !== store) throw new TypeError("An atomic mutation belongs to a different CatalogueStore.");
    for (const before of group.before) append(before);
    const position = append(group.statement);
    for (const after of group.after) append(after);
    return position;
  };
  const positions = statements.map(append);
  if (expanded.length > 900) {
    throw new Error("A catalogue atomic batch exceeds its 900-statement D1 budget after guard expansion.");
  }
  const results = await database.batch<T>(expanded);
  return positions.map((position) => {
    const result = results[position];
    if (result === undefined) throw new Error("D1 did not return every atomic batch result.");
    return result;
  });
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
