import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import type { RelationshipKind } from "./reconciliation-relationships";

export type HistoryPublication = { candidate: string } | { revision: string };
export type SourceHistoryRecord = {
  id: string;
  kind: "card" | "locator" | "membership";
  entityId: string;
  cardId: string;
  sourceLineage: string;
  identity: { kind: string; value: string | null };
  locator?: string;
  variantKey?: string | null;
  relationshipKind?: RelationshipKind;
  relationshipValue?: string;
  sourceObservationId?: string;
  first: HistoryPublication;
  last: HistoryPublication;
  missing: HistoryPublication | null;
  current: boolean;
};
export type SourceHistoryPosition = { position: number; count: number; entities: number };

/** Private history is separate from consumer facts and each preparation owns its immutable prefix. */
export class NativeSourceHistory {
  readonly index: ReconciliationReducerIndex<SourceHistoryRecord>;
  private count = 0;
  private entities: ReconciliationReducerIndex<number>;
  constructor(
    database: CatalogueStore,
    preparation: string,
    position: SourceHistoryPosition = { position: 0, count: 0, entities: 0 },
  ) {
    this.index = new ReconciliationReducerIndex(database, preparation, "source_history", sourceHistoryGroup);
    this.entities = new ReconciliationReducerIndex(database, preparation, "source_history_entity_counts");
    this.resumeAt(position);
  }
  get cursor(): SourceHistoryPosition {
    return { position: this.index.position, count: this.count, entities: this.entities.position };
  }
  resumeAt(cursor: SourceHistoryPosition) {
    if (!Number.isSafeInteger(cursor.count) || cursor.count < 0 || cursor.count > cursor.position)
      throw new Error("Native source history has an invalid completed prefix.");
    this.index.resumeAt(cursor.position);
    this.count = cursor.count;
    this.entities.resumeAt(cursor.entities);
  }
  async retain(value: SourceHistoryRecord, options?: { preserveFirst: boolean }) {
    const previous = await this.index.get(value.id);
    if (options?.preserveFirst && previous) value = { ...value, first: previous.first };
    if (!previous) {
      const group = sourceHistoryGroup(value);
      const count = ((await this.entities.get(group)) ?? 0) + 1;
      this.entities.beginObservation();
      this.index.beginObservation();
      await this.index.setAlongside(value.id, value, { index: this.entities, key: group, value: count });
      this.count++;
    } else {
      await this.index.seed(value.id, value);
    }
  }
  async retainObservations(records: readonly SourceHistoryRecord[]) {
    if (records.length > 8 || new TextEncoder().encode(canonicalJson(records)).byteLength > 131072)
      throw new Error("Source history observation batch exceeds its bounded allowance.");
    const previous = await this.index.getMany(records.map((record) => record.id));
    const counts = previous && (await this.entities.getMany(records.map(sourceHistoryGroup)));
    if (!previous || !counts) {
      for (const record of records) await this.retain(record, { preserveFirst: true });
      return;
    }
    const entries = [],
      entityEntries = [];
    let added = 0;
    for (const record of records) {
      const prior = previous.get(record.id);
      const value = prior ? { ...record, first: prior.first } : record;
      if (!prior) {
        const group = sourceHistoryGroup(value);
        const count = (counts.get(group) ?? 0) + 1;
        counts.set(group, count);
        entityEntries.push({ key: group, value: count });
        added++;
      }
      entries.push({ key: value.id, value });
      previous.set(value.id, value);
    }
    await this.index.seedManyAlongside(entries, { index: this.entities, entries: entityEntries });
    this.count += added;
  }
  async *entries(after = "") {
    for await (const entry of this.index.latestEntries(after)) {
      if ((await sha256Text(entry.value.id)) !== entry.key)
        throw new Error("Native source history key differs from its retained record.");
      yield entry;
    }
  }
  async *entityRecords(kind: "card" | "printing", entityId: string) {
    const group = canonicalJson([kind, entityId]);
    this.index.beginObservation();
    let count = 0;
    try {
      for await (const entry of this.index.groupEntriesBeforeObservation(group)) {
        if (sourceHistoryGroup(entry.value) !== group || (await sha256Text(entry.value.id)) !== entry.key)
          throw new Error("Native source history group or key differs from its retained record.");
        count++;
        yield entry.value;
      }
    } finally {
      this.index.resumeAt(this.index.position - 1);
    }
    if (count !== ((await this.entities.get(group)) ?? 0))
      throw new Error("Native source history entity prefix is missing records.");
  }
  async forEntity(kind: "card" | "printing", entityId: string, recordKind?: SourceHistoryRecord["kind"]) {
    const records: SourceHistoryRecord[] = [];
    for await (const record of this.entityRecords(kind, entityId))
      if (!recordKind || record.kind === recordKind) records.push(record);
    return records;
  }
  /** Bound the existing non-paginated administration response, never retained history or preparation. */
  async administrationRecords(kind: "card" | "printing", entityId: string) {
    const records: SourceHistoryRecord[] = [];
    let bytes = 0;
    for await (const record of this.entityRecords(kind, entityId)) {
      bytes += new TextEncoder().encode(canonicalJson(record)).byteLength;
      if (records.length === 1024 || bytes > 1048576)
        throw new AdministrationProblem(
          409,
          "source_history_capacity_exceeded",
          "Administration history exceeds 1024 records or 1048576 bytes; retained evidence remains intact.",
        );
      records.push(record);
    }
    return records;
  }
}
function sourceHistoryGroup(record: SourceHistoryRecord) {
  return canonicalJson([record.kind === "card" ? "card" : "printing", record.entityId]);
}
