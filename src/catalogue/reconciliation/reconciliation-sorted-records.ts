import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { ReconciliationReducerStorageError } from "./reconciliation-reducer-state";
import { retainPartitionedRecord, restorePartitionedRecord } from "./reconciliation-text";
import { retainSortBatchStatement, sortBatchStatement } from "./reconciliation-sort-repository";

type Envelope = Awaited<ReturnType<typeof retainPartitionedRecord>>;
type Item = { key: string; envelope: Envelope };
async function storage<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    throw new ReconciliationReducerStorageError(cause);
  }
}

/** Four-way external merge preserves JavaScript's canonical text order with bounded resident batches. */
export class ReconciliationSortedRecords<T> implements AsyncIterable<T> {
  private pending: Item[] = [];
  private bytes = 0;
  private runs = 0;
  private finalPass: number | undefined;
  constructor(
    private database: CatalogueStore,
    private runId: string,
    private namespace: string,
  ) {}

  async append(value: T): Promise<void> {
    if (this.finalPass !== undefined) throw new Error("Cannot append to sealed sorted records.");
    const key = canonicalJson(value);
    const bytes = new TextEncoder().encode(key).byteLength;
    if (this.pending.length && (this.pending.length === 100 || this.bytes + bytes > 512000)) await this.flush();
    const envelope = await retainPartitionedRecord(this.database, this.runId, value);
    this.pending.push({ key, envelope });
    this.bytes += bytes;
    // A large text record owns its batch; its retained metadata still has the ordinary byte limit.
    if (this.bytes >= 512000) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.pending.length) return;
    this.pending.sort((a, b) => a.key.localeCompare(b.key));
    await this.writeRun(0, this.runs, this.pending);
    this.runs++;
    this.pending = [];
    this.bytes = 0;
  }

  async seal(): Promise<void> {
    if (this.finalPass !== undefined) return;
    await this.flush();
    if (!this.runs) {
      await this.writeRun(0, 0, []);
      this.runs = 1;
    }
    let pass = 0,
      count = this.runs;
    while (count > 1) {
      let output = 0;
      for (let first = 0; first < count; first += 4) {
        await this.writeRun(pass + 1, output++, this.merge(pass, first, Math.min(4, count - first)));
      }
      count = output;
      pass++;
    }
    this.finalPass = pass;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    await this.seal();
    for await (const item of this.readRun(this.finalPass!, 0))
      yield (await restorePartitionedRecord(this.database, this.runId, item.envelope)) as T;
  }

  private async *merge(pass: number, first: number, count: number): AsyncGenerator<Item> {
    const streams = Array.from({ length: count }, (_, offset) => this.readRun(pass, first + offset));
    try {
      const heads = await Promise.all(streams.map((stream) => stream.next()));
      for (;;) {
        let selected = -1;
        for (let i = 0; i < heads.length; i++)
          if (
            !heads[i]!.done &&
            (selected === -1 || heads[i]!.value!.key.localeCompare(heads[selected]!.value!.key) < 0)
          )
            selected = i;
        if (selected === -1) return;
        yield heads[selected]!.value!;
        heads[selected] = await streams[selected]!.next();
      }
    } finally {
      await Promise.all(streams.map((stream) => stream.return(undefined)));
    }
  }

  private async *readRun(pass: number, run: number): AsyncGenerator<Item> {
    for (let batch = 0; ; batch++) {
      const row = await storage(
        sortBatchStatement(this.database, this.runId, this.namespace, pass, run, batch).first<{
          content: string;
          sha256: string;
        }>(),
      );
      if (!row || (await sha256Text(row.content)) !== row.sha256)
        throw new Error("Sorted reconciliation records failed integrity verification.");
      const records = JSON.parse(row.content) as Envelope[];
      if (!records.length) return;
      for (const envelope of records) {
        const value = await restorePartitionedRecord(this.database, this.runId, envelope);
        yield { envelope, key: canonicalJson(value) };
      }
    }
  }

  private async writeRun(pass: number, run: number, values: Iterable<Item> | AsyncIterable<Item>): Promise<void> {
    let pending: Envelope[] = [],
      bytes = 2,
      ordinal = 0;
    const write = async () => {
      const content = canonicalJson(pending),
        sha256 = await sha256Text(content);
      const inserted = await storage(
        retainSortBatchStatement(this.database, this.runId, this.namespace, pass, run, ordinal, content, sha256).first<{
          content: string;
          sha256: string;
        }>(),
      );
      const row =
        inserted ??
        (await storage(
          sortBatchStatement(this.database, this.runId, this.namespace, pass, run, ordinal).first<{
            content: string;
            sha256: string;
          }>(),
        ));
      if (!row || row.content !== content || row.sha256 !== sha256)
        throw new Error("Sorted reconciliation replay differs from retained records.");
      ordinal++;
      pending = [];
      bytes = 2;
    };
    for await (const { envelope } of values) {
      const size = new TextEncoder().encode(canonicalJson(envelope)).byteLength;
      if (size + 2 > 512000)
        throw new Error("reconciliation_capacity_exceeded: one sorted record exceeds its metadata budget.");
      if (pending.length && (pending.length === 100 || bytes + size + 1 > 512000)) await write();
      bytes += size + (pending.length ? 1 : 0);
      pending.push(envelope);
    }
    if (pending.length) await write();
    // An immutable terminator distinguishes an empty or complete run from missing retained data.
    await write();
  }
}
