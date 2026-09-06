import { type CatalogueStore, canonicalJson } from "../shared";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";

/** Immutable record batches preserve replay order without a write for every small record. */
export class ReconciliationRecordLog<T> {
  private readonly index: ReconciliationReducerIndex<{ id: string; records: T[] }>;
  private pending: T[] = [];
  private bytes = 2;
  private ordinal = 0;

  constructor(database: CatalogueStore, runId: string, namespace: string) {
    this.index = new ReconciliationReducerIndex(database, runId, namespace);
  }

  async checkpoint(): Promise<number> {
    await this.flush();
    return this.ordinal;
  }
  resumeAt(position: number) {
    this.index.resumeAt(position);
    this.ordinal = position;
    this.pending = [];
    this.bytes = 2;
  }

  async append(record: T): Promise<void> {
    const bytes = new TextEncoder().encode(canonicalJson(record)).byteLength;
    // Leave room for the retained batch envelope inside the 512 KiB metadata limit.
    if (bytes + 2 > 512000)
      throw new Error("reconciliation_capacity_exceeded: one retained record exceeds its metadata budget.");
    if (this.pending.length === 100 || this.bytes + bytes + 1 > 512000) await this.flush();
    this.bytes += bytes + (this.pending.length ? 1 : 0);
    this.pending.push(record);
  }

  private async flush(): Promise<void> {
    if (!this.pending.length) return;
    const id = String(this.ordinal).padStart(12, "0");
    await this.index.seed(id, { id, records: this.pending });
    this.ordinal++;
    this.pending = [];
    this.bytes = 2;
  }

  async *records(): AsyncGenerator<T> {
    await this.flush();
    for await (const batch of this.index.entityValues()) yield* batch.records;
  }
}
