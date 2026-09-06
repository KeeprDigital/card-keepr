import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { ReconciliationSortedRecords } from "./reconciliation-sorted-records";

export type ReconciliationRecordSink<T> = { push(...records: T[]): Promise<void> };

/** A persistent distinct record collection, with canonical ordering applied only after producers finish. */
export class ReconciliationRecordCollection<T extends Record<string, unknown>>
  implements AsyncIterable<T>, ReconciliationRecordSink<T>
{
  private index: ReconciliationReducerIndex<{ id: string; value: T }>;
  private count = 0;
  private sorted: ReconciliationSortedRecords<T> | undefined;
  constructor(
    private database: CatalogueStore,
    private runId: string,
    private namespace: string,
    private distinct = true,
  ) {
    this.index = new ReconciliationReducerIndex(database, runId, namespace, ({ value }) =>
      String(value.source_observation_id ?? ""),
    );
  }
  get cursor() {
    return { position: this.index.position, count: this.count };
  }
  resumeAt(cursor: { position: number; count: number }) {
    this.index.resumeAt(cursor.position);
    this.count = cursor.count;
    this.sorted = undefined;
  }
  async push(...records: T[]): Promise<void> {
    if (this.sorted) throw new Error("Cannot append to sealed reconciliation records.");
    for (const value of records) {
      const id = this.distinct ? await sha256Text(canonicalJson(value)) : String(this.count).padStart(12, "0");
      await this.index.seed(id, { id, value });
      this.count++;
    }
  }
  get length() {
    return this.count;
  }
  async hasObservation(observationId: string, code?: string): Promise<boolean> {
    if (this.count === 0) return false;
    this.index.beginObservation();
    for await (const { value } of this.index.matchingBeforeObservation(observationId))
      if (code === undefined || value.code === code) return true;
    return false;
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    if (!this.sorted) {
      const sorted = new ReconciliationSortedRecords<T>(this.database, this.runId, `${this.namespace}_sorted`);
      for await (const { value } of this.index.insertionValues()) await sorted.append(value);
      await sorted.seal();
      this.sorted = sorted;
    }
    yield* this.sorted;
  }
}
