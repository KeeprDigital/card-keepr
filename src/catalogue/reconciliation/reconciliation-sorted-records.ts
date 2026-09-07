import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { documentStorage } from "./reconciliation-document";
import { retainPartitionedRecord, restorePartitionedRecord } from "./reconciliation-text";
import { retainSortBatchStatement, sortBatchStatement } from "./reconciliation-sort-repository";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";

type Envelope = Awaited<ReturnType<typeof retainPartitionedRecord>>;
type Item<T> = { key: string; envelope: Envelope; value: T };
type Position = { batch: number; offset: number };
type Cursor = {
  sourceVersion: number;
  after: number;
  stage: "runs" | "merge" | "complete";
  count: number;
  pass: number;
  first: number;
  outputBatch: number;
  positions: Position[];
};

/** Four-way canonical text merge with durable input and output batch cursors. */
export class ReconciliationSortedRecords<T> implements AsyncIterable<T> {
  private finalPass: number | undefined;
  constructor(
    private database: CatalogueStore,
    private runId: string,
    private namespace: string,
  ) {}

  async prepareRuns(
    sourceVersion: number,
    source: (after: number) => AsyncIterable<{ ordinal: number; value: T }>,
    yieldAtCheckpoint: boolean,
  ): Promise<void> {
    const phase = `record_sorting:${this.namespace}` as const;
    const checkpoint = await reconciliationCheckpoint<Cursor>(this.database, this.runId, phase);
    const cursor: Cursor = checkpoint?.value ?? {
      sourceVersion,
      after: 0,
      stage: "runs",
      count: 0,
      pass: 0,
      first: 0,
      outputBatch: 0,
      positions: [],
    };
    if (cursor.sourceVersion !== sourceVersion) throw new Error("Sorted reconciliation source prefix changed.");
    let ordinal = (checkpoint?.ordinal ?? -1) + 1;
    const save = async () => {
      await retainReconciliationCheckpoint(this.database, this.runId, phase, ordinal, cursor);
      if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase, ordinal });
      ordinal++;
    };
    if (cursor.stage === "runs") {
      let pending: Item<T>[] = [],
        bytes = 0;
      const flush = async () => {
        pending.sort((a, b) => a.key.localeCompare(b.key));
        await this.writeBatch(0, cursor.count, 0, pending);
        await this.writeBatch(0, cursor.count, 1, []);
        cursor.count++;
        pending = [];
        bytes = 0;
        await save();
      };
      for await (const entry of source(cursor.after)) {
        const key = canonicalJson(entry.value);
        const size = sortableSize(key);
        if (pending.length && bytes + size > 512000) await flush();
        const envelope = await retainPartitionedRecord(this.database, this.runId, entry.value);
        pending.push({ key, envelope, value: entry.value });
        bytes += size;
        cursor.after = entry.ordinal;
        if (pending.length === 8 || bytes >= 512000) await flush();
      }
      if (pending.length) await flush();
      if (!cursor.count) {
        await this.writeBatch(0, 0, 0, []);
        cursor.count = 1;
      }
      cursor.stage = cursor.count === 1 ? "complete" : "merge";
      await save();
    }
    if (cursor.stage === "merge") {
      while (cursor.count > 1) {
        while (cursor.first < cursor.count) {
          const count = Math.min(4, cursor.count - cursor.first);
          if (!cursor.positions.length)
            cursor.positions = Array.from({ length: count }, () => ({ batch: 0, offset: 0 }));
          const heads = await Promise.all(
            cursor.positions.map((position, offset) => this.readHead(cursor.pass, cursor.first + offset, position)),
          );
          let pending: Item<T>[] = [],
            bytes = 0;
          const flush = async () => {
            await this.writeBatch(cursor.pass + 1, Math.floor(cursor.first / 4), cursor.outputBatch, pending);
            cursor.outputBatch++;
            pending = [];
            bytes = 0;
            await save();
          };
          for (;;) {
            let selected = -1;
            for (let index = 0; index < heads.length; index++)
              if (heads[index] && (selected === -1 || heads[index]!.key.localeCompare(heads[selected]!.key) < 0))
                selected = index;
            if (selected === -1) break;
            const head = heads[selected]!;
            const size = sortableSize(head.key);
            if (pending.length && bytes + size > 512000) await flush();
            pending.push(head);
            bytes += size;
            cursor.positions[selected]!.offset++;
            heads[selected] = await this.readHead(cursor.pass, cursor.first + selected, cursor.positions[selected]!);
            if (pending.length === 8 || bytes >= 512000) await flush();
          }
          if (pending.length) await flush();
          await this.writeBatch(cursor.pass + 1, Math.floor(cursor.first / 4), cursor.outputBatch, []);
          cursor.first += 4;
          cursor.outputBatch = 0;
          cursor.positions = [];
          await save();
        }
        cursor.count = Math.ceil(cursor.count / 4);
        cursor.pass++;
        cursor.first = 0;
        if (cursor.count === 1) cursor.stage = "complete";
        await save();
      }
    }
    this.finalPass = cursor.pass;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for await (const entry of this.canonicalEntries("")) yield entry.value;
  }

  async *canonicalEntries(after: string): AsyncGenerator<{ key: string; value: T }> {
    if (this.finalPass === undefined) throw new Error("Sorted reconciliation records must be prepared before reading.");
    const position: Position = after ? JSON.parse(after) : { batch: 0, offset: 0 };
    for (;;) {
      const item = await this.readHead(this.finalPass, 0, position);
      if (!item) return;
      position.offset++;
      yield { key: canonicalJson(position), value: item.value };
    }
  }

  private async readHead(pass: number, run: number, position: Position): Promise<Item<T> | null> {
    for (;;) {
      const row = await documentStorage(() =>
        sortBatchStatement(this.database, this.runId, this.namespace, pass, run, position.batch).first<{
          content: string;
          sha256: string;
        }>(),
      );
      if (!row || (await sha256Text(row.content)) !== row.sha256)
        throw new Error("Sorted reconciliation records failed integrity verification.");
      const records = JSON.parse(row.content) as Envelope[];
      if (!records.length) return null;
      if (position.offset >= records.length) {
        position.batch++;
        position.offset = 0;
        continue;
      }
      const envelope = records[position.offset]!;
      const value = (await restorePartitionedRecord(this.database, this.runId, envelope)) as T;
      const key = canonicalJson(value);
      sortableSize(key);
      return { key, envelope, value };
    }
  }

  private async writeBatch(pass: number, run: number, ordinal: number, items: Item<T>[]): Promise<void> {
    const content = canonicalJson(items.map((item) => item.envelope));
    if (new TextEncoder().encode(content).byteLength > 524288)
      throw new Error("reconciliation_capacity_exceeded: one sorted batch exceeds 512 KiB.");
    const sha256 = await sha256Text(content);
    const inserted = await documentStorage(() =>
      retainSortBatchStatement(this.database, this.runId, this.namespace, pass, run, ordinal, content, sha256).first<{
        content: string;
        sha256: string;
      }>(),
    );
    const row =
      inserted ??
      (await documentStorage(() =>
        sortBatchStatement(this.database, this.runId, this.namespace, pass, run, ordinal).first<{
          content: string;
          sha256: string;
        }>(),
      ));
    if (!row || row.content !== content || row.sha256 !== sha256)
      throw new Error("Sorted reconciliation replay differs from retained records.");
  }
}

function sortableSize(key: string): number {
  const bytes = new TextEncoder().encode(key).byteLength;
  // Four comparison heads plus a single oversized output stay below the 64 MiB
  // memory budget, including hydrated values and UTF-16 canonical keys. Text is
  // retained separately; only the envelopes must fit the metadata-sized batches.
  if (bytes > 2097152)
    throw new Error("reconciliation_capacity_exceeded: one sortable diagnostic or semantic record exceeds 2 MiB.");
  return bytes;
}
