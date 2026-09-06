import {
  type CatalogueCandidate,
  type CatalogueDraft,
  type CatalogueDraftEntity,
  type CatalogueEntityCollection,
  type CatalogueStore,
  catalogueEntityCollections,
} from "../shared";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";

type EntityRow = { id: string; entity: unknown | null };

/** Entity updates and tombstones share the reducer's immutable replay history. */
export class ReconciliationCandidateState implements CatalogueDraft {
  private readonly indexes = new Map<CatalogueEntityCollection, ReconciliationReducerIndex<EntityRow>>();
  constructor(
    private readonly database: CatalogueStore,
    private readonly runId: string,
    private readonly phase: string,
  ) {}

  private index(kind: CatalogueEntityCollection): ReconciliationReducerIndex<EntityRow> {
    let index = this.indexes.get(kind);
    if (!index) {
      index = new ReconciliationReducerIndex<EntityRow>(this.database, this.runId, `candidate_${this.phase}_${kind}`);
      this.indexes.set(kind, index);
    }
    return index;
  }

  async get<K extends CatalogueEntityCollection>(kind: K, id: string): Promise<CatalogueDraftEntity<K> | undefined> {
    const row = await this.index(kind).get(id);
    return row?.entity == null ? undefined : (row.entity as CatalogueDraftEntity<K>);
  }
  async has(kind: CatalogueEntityCollection, id: string): Promise<boolean> {
    return this.index(kind).hasEntity(id);
  }
  async set<K extends CatalogueEntityCollection>(kind: K, entity: CatalogueDraftEntity<K>): Promise<void> {
    await this.index(kind).seed(entity.id, { id: entity.id, entity });
  }
  async delete(kind: CatalogueEntityCollection, id: string): Promise<void> {
    await this.index(kind).seed(id, { id, entity: null });
  }
  async *values<K extends CatalogueEntityCollection>(kind: K): AsyncGenerator<CatalogueDraftEntity<K>> {
    for await (const row of this.index(kind).entityValues()) {
      if (row.entity !== null) yield row.entity as CatalogueDraftEntity<K>;
    }
  }

  async seed(
    candidate: CatalogueCandidate,
    kinds: readonly CatalogueEntityCollection[] = catalogueEntityCollections,
  ): Promise<void> {
    for (const kind of kinds) for (const entity of candidate[kind] ?? []) await this.set(kind, entity);
  }

  /** Legacy aggregate callers can still inspect the completed state during migration to streamed preparation. */
  async candidate(metadata: CatalogueCandidate): Promise<CatalogueCandidate> {
    const result = { ...metadata };
    for (const kind of catalogueEntityCollections) {
      if (metadata[kind] === undefined && !this.indexes.has(kind)) continue;
      const values = [];
      for await (const entity of this.values(kind)) values.push(entity);
      if (kind === "identity_corrections" && values.length === 0 && metadata[kind] === undefined) continue;
      Object.defineProperty(result, kind, { value: values, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
}
