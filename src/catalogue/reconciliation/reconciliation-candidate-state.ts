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
  private readonly collections = new Set<CatalogueEntityCollection>();
  private readonly indexes = new Map<CatalogueEntityCollection, ReconciliationReducerIndex<EntityRow>>();
  constructor(
    private readonly database: CatalogueStore,
    private readonly runId: string,
    private readonly phase: string,
    private readonly base?: ReconciliationCandidateState,
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
    if (row === undefined) return this.base?.get(kind, id);
    return row.entity === null ? undefined : (row.entity as CatalogueDraftEntity<K>);
  }
  async has(kind: CatalogueEntityCollection, id: string): Promise<boolean> {
    const present = await this.index(kind).hasEntity(id);
    return present ?? (await this.base?.has(kind, id)) ?? false;
  }
  async set<K extends CatalogueEntityCollection>(kind: K, entity: CatalogueDraftEntity<K>): Promise<void> {
    this.collections.add(kind);
    await this.index(kind).seed(entity.id, { id: entity.id, entity });
  }
  async delete(kind: CatalogueEntityCollection, id: string): Promise<void> {
    this.collections.add(kind);
    await this.index(kind).seed(id, { id, entity: null });
  }
  async *values<K extends CatalogueEntityCollection>(kind: K): AsyncGenerator<CatalogueDraftEntity<K>> {
    if (!this.base) {
      for await (const row of this.index(kind).entityValues()) {
        if (row.entity !== null) yield row.entity as CatalogueDraftEntity<K>;
      }
      return;
    }
    const inherited = this.base.values(kind)[Symbol.asyncIterator]();
    const changed = this.index(kind).entityValues();
    try {
      let left = await inherited.next();
      let right = await changed.next();
      while (!left.done || !right.done) {
        if (!left.done && (right.done || left.value.id < right.value.id)) {
          yield left.value;
          left = await inherited.next();
        } else if (!right.done && (left.done || right.value.id < left.value.id)) {
          if (right.value.entity !== null) yield right.value.entity as CatalogueDraftEntity<K>;
          right = await changed.next();
        } else {
          if (!right.done && right.value.entity !== null) yield right.value.entity as CatalogueDraftEntity<K>;
          left = await inherited.next();
          right = await changed.next();
        }
      }
    } finally {
      await inherited.return(undefined);
      await changed.return(undefined);
    }
  }

  async seed(
    candidate: CatalogueCandidate,
    kinds: readonly CatalogueEntityCollection[] = catalogueEntityCollections,
  ): Promise<void> {
    for (const kind of kinds) {
      this.collections.add(kind);
      for (const entity of candidate[kind] ?? []) await this.set(kind, entity);
    }
  }

  private represents(kind: CatalogueEntityCollection): boolean {
    return this.collections.has(kind) || this.base?.represents(kind) === true;
  }

  /** Reusable collections allow hashing and preparation to read the same pinned view. */
  async document(metadata: CatalogueCandidate): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = { ...metadata };
    for (const kind of catalogueEntityCollections) {
      if (!this.represents(kind)) continue;
      if (metadata[kind] === undefined) {
        const values = this.values(kind);
        try {
          if ((await values.next()).done) continue;
        } finally {
          await values.return(undefined);
        }
      }
      const draft = this;
      result[kind] = {
        [Symbol.asyncIterator]() {
          return draft.values(kind);
        },
      };
    }
    return result;
  }
}
