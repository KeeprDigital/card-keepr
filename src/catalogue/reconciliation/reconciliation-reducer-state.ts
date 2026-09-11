import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { retainPartitionedRecord, restorePartitionedRecord } from "./reconciliation-text";
import {
  nextLatestReducerStateStatement,
  nextReducerInsertionStateStatement,
  nextReducerEntityStateStatement,
  nextReducerGroupStateStatement,
  exactReducerStateStatement,
  reducerStateStatement,
  retainReducerStateStatement,
} from "./reconciliation-reducer-state-repository";

export class ReconciliationReducerStorageError extends Error {
  constructor(cause: unknown) {
    super("Reconciliation reducer storage is temporarily unavailable.", { cause });
    this.name = "ReconciliationReducerStorageError";
  }
}
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new ReconciliationReducerStorageError(cause);
  }
}

type StateRow = { content: string; sha256: string };

/** A replay sees its predecessor state, even when later observations already have retained effects. */
export class ReconciliationReducerIndex<T> {
  private ordinal = 0;
  private completedPrefix = false;
  private written = new Set<string>();
  private lastWrite: { digest: string; content: string } | null = null;
  constructor(
    private database: CatalogueStore,
    private runId: string,
    private namespace: string,
    private group?: (value: T) => string,
  ) {}

  get position() {
    return this.ordinal;
  }

  /** Reopen exactly the completed prefix; uncheckpointed future effects stay invisible. */
  resumeAt(position: number) {
    if (!Number.isSafeInteger(position) || position < 0) throw new Error("Invalid reducer continuation position.");
    this.ordinal = position;
    this.written.clear();
    this.lastWrite = null;
    this.completedPrefix = true;
  }

  beginObservation() {
    this.completedPrefix = false;
    this.ordinal++;
    this.written.clear();
    this.lastWrite = null;
  }

  async seed(key: string, value: T): Promise<void> {
    this.beginObservation();
    await this.set(key, value);
  }

  /** Independent seed effects retain their original ordinals in bounded transactions. */
  async seedMany(entries: Iterable<{ key: string; value: T }>): Promise<void> {
    let writes: Awaited<ReturnType<typeof this.prepareWrite>>[] = [];
    let bytes = 0;
    const flush = async () => {
      if (!writes.length) return;
      const results = await storage(() => this.database.batch<StateRow>(writes.map((write) => write.statement())));
      for (const [index, write] of writes.entries()) await write.accept(results[index]?.results[0] ?? null);
      writes = [];
      bytes = 0;
    };
    for (const entry of entries) {
      this.beginObservation();
      const write = await this.prepareWrite(entry.key, entry.value);
      if (writes.length && (writes.length === 16 || bytes + write.bytes > 262144)) await flush();
      writes.push(write);
      bytes += write.bytes;
    }
    await flush();
  }

  private async readRequest(key: string): Promise<{ cached?: T; statement?: D1PreparedStatement }> {
    if (this.ordinal === 0) return {};
    const digest = await sha256Text(key);
    if (this.lastWrite?.digest === digest) return { cached: JSON.parse(this.lastWrite.content).value as T };
    return {
      statement: reducerStateStatement(
        this.database,
        this.runId,
        this.namespace,
        digest,
        this.ordinal + (this.completedPrefix || this.written.has(digest) ? 1 : 0),
      ),
    };
  }
  private async restoreRow(row: StateRow | null): Promise<T | undefined> {
    if (!row) return undefined;
    if ((await sha256Text(row.content)) !== row.sha256) throw new Error("Reducer state failed integrity verification.");
    return (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T;
  }
  async get(key: string): Promise<T | undefined> {
    const request = await this.readRequest(key);
    return request.statement
      ? this.restoreRow(await storage(() => request.statement!.first<StateRow>()))
      : request.cached;
  }

  /** Read independent Product and Distribution Context predecessors in one transaction. */
  async getAlongside<U>(
    key: string,
    other: { index: ReconciliationReducerIndex<U>; key: string },
  ): Promise<[T | undefined, U | undefined]> {
    if (this.database !== other.index.database) throw new Error("Reducer reads require the same catalogue store.");
    const left = await this.readRequest(key);
    const right = await other.index.readRequest(other.key);
    const statements = [left.statement, right.statement].filter(
      (value): value is D1PreparedStatement => value !== undefined,
    );
    const results = statements.length ? await storage(() => this.database.batch<StateRow>(statements)) : [];
    let position = 0;
    return [
      left.statement ? await this.restoreRow(results[position++]?.results[0] ?? null) : left.cached,
      right.statement ? await other.index.restoreRow(results[position]?.results[0] ?? null) : right.cached,
    ];
  }

  /** Query only the predecessor view; call before this observation writes matching state. */
  async *matchingBeforeObservation(group: string, limit = { records: 500, bytes: 1048576 }): AsyncGenerator<T> {
    let bytes = 0,
      count = 0;
    for await (const entry of this.groupEntriesBeforeObservation(group)) {
      bytes += entry.bytes;
      if (++count > limit.records || bytes > limit.bytes)
        throw new Error("reconciliation_capacity_exceeded: one identity match has too many candidates.");
      yield entry.value;
    }
  }

  /** Stream lifetime history in verified bounded pages, without an identity-match ceiling. */
  async *groupEntriesBeforeObservation(
    group: string,
    after = "",
  ): AsyncGenerator<{ key: string; value: T; bytes: number }> {
    if (this.ordinal <= 1) return;
    const groupDigest = await sha256Text(group);
    for (;;) {
      const ordinal = this.ordinal;
      const page = await storage(() =>
        nextReducerGroupStateStatement(this.database, this.runId, this.namespace, groupDigest, ordinal, after).all<
          StateRow & { key_digest: string }
        >(),
      );
      if (!page.results.length) return;
      for (const row of page.results) {
        if ((await sha256Text(row.content)) !== row.sha256)
          throw new Error("Reducer state failed integrity verification.");
        yield {
          key: row.key_digest,
          value: (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T,
          bytes: new TextEncoder().encode(row.content).byteLength,
        };
        after = row.key_digest;
        if (this.ordinal !== ordinal) break;
      }
    }
  }

  /** Iterate the completed observation prefix without rebuilding its complete index. */
  async *latestValues(): AsyncGenerator<T> {
    for await (const entry of this.latestEntries()) yield entry.value;
  }

  async *latestEntries(after = ""): AsyncGenerator<{ key: string; value: T }> {
    if (this.ordinal === 0) return;
    for (;;) {
      const ordinal = this.ordinal;
      const page = await storage(() =>
        nextLatestReducerStateStatement(this.database, this.runId, this.namespace, ordinal, after).all<
          StateRow & { key_digest: string }
        >(),
      );
      if (!page.results.length) return;
      for (const row of page.results) {
        if ((await sha256Text(row.content)) !== row.sha256)
          throw new Error("Reducer state failed integrity verification.");
        yield {
          key: row.key_digest,
          value: (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T,
        };
        after = row.key_digest;
        if (this.ordinal !== ordinal) break;
      }
    }
  }

  /** Stable first-insertion order for maps populated exclusively through seed(). */
  async *insertionValues(): AsyncGenerator<T> {
    for await (const entry of this.insertionEntries()) yield entry.value;
  }
  async *insertionEntries(after = 0): AsyncGenerator<{ ordinal: number; value: T }> {
    if (this.ordinal === 0) return;
    for (;;) {
      const page = await storage(() =>
        nextReducerInsertionStateStatement(this.database, this.runId, this.namespace, this.ordinal, after).all<
          StateRow & { first_ordinal: number }
        >(),
      );
      if (!page.results.length) return;
      for (const row of page.results) {
        if ((await sha256Text(row.content)) !== row.sha256)
          throw new Error("Reducer state failed integrity verification.");
        yield {
          ordinal: row.first_ordinal,
          value: (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T,
        };
        after = row.first_ordinal;
      }
    }
  }

  /** Entity drafts retain stable ID order while applying deletions and updates during iteration. */
  async *entityValues(after = ""): AsyncGenerator<T> {
    if (this.ordinal === 0) return;
    for (;;) {
      const ordinal = this.ordinal;
      const page = await storage(() =>
        nextReducerEntityStateStatement(this.database, this.runId, this.namespace, ordinal, after).all<
          StateRow & { entity_id: string }
        >(),
      );
      if (!page.results.length) return;
      for (const row of page.results) {
        if ((await sha256Text(row.content)) !== row.sha256)
          throw new Error("Reducer state failed integrity verification.");
        yield (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T;
        after = row.entity_id;
        // Mutating consumers must see any changes to the unread suffix.
        if (this.ordinal !== ordinal) break;
      }
    }
  }

  /** Draft existence checks verify metadata without hydrating the entity's retained text. */
  async hasEntity(key: string): Promise<boolean | undefined> {
    if (this.ordinal === 0) return undefined;
    const digest = await sha256Text(key);
    const row = await storage(() =>
      reducerStateStatement(
        this.database,
        this.runId,
        this.namespace,
        digest,
        this.ordinal + (this.completedPrefix || this.written.has(digest) ? 1 : 0),
      ).first<StateRow>(),
    );
    if (!row) return undefined;
    if ((await sha256Text(row.content)) !== row.sha256) throw new Error("Reducer state failed integrity verification.");
    const envelope = JSON.parse(row.content) as { value: { entity: unknown } };
    return envelope.value.entity !== null;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async set(key: string, value: T): Promise<void> {
    const write = await this.prepareWrite(key, value);
    await write.accept(await storage(() => write.statement().first<StateRow>()));
  }

  /** One Card, its identity reference, and optional comparison facts share a transaction. */
  async setAlongside<U, V = never>(
    key: string,
    value: T,
    other: { index: ReconciliationReducerIndex<U>; key: string; value: U },
    additional?: { index: ReconciliationReducerIndex<V>; key: string; value: V },
  ) {
    if (this.database !== other.index.database || (additional && this.database !== additional.index.database))
      throw new Error("Reducer writes require the same catalogue store.");
    const left = await this.prepareWrite(key, value);
    const right = await other.index.prepareWrite(other.key, other.value);
    const writes = [left, right];
    if (additional) writes.push(await additional.index.prepareWrite(additional.key, additional.value));
    const results = await storage(() => this.database.batch<StateRow>(writes.map((write) => write.statement())));
    for (const [index, write] of writes.entries()) await write.accept(results[index]?.results[0] ?? null);
  }

  private async prepareWrite(key: string, value: T) {
    const ordinal = this.ordinal;
    const digest = await sha256Text(key);
    const envelope = await retainPartitionedRecord(this.database, this.runId, JSON.parse(JSON.stringify(value)));
    const content = canonicalJson(envelope);
    if (new TextEncoder().encode(content).byteLength > 524288)
      throw new Error("reconciliation_capacity_exceeded: one reducer fact exceeds 512 KiB.");
    const sha256 = await sha256Text(content);
    const groupDigest = this.group ? await sha256Text(this.group(value)) : null;
    return {
      bytes: new TextEncoder().encode(content).byteLength,
      statement: () =>
        retainReducerStateStatement(
          this.database,
          this.runId,
          this.namespace,
          digest,
          ordinal,
          content,
          sha256,
          groupDigest,
        ),
      accept: async (inserted: StateRow | null) => {
        const retained =
          inserted ??
          (await storage(() =>
            exactReducerStateStatement(this.database, this.runId, this.namespace, digest, ordinal).first<StateRow>(),
          ));
        if (retained?.content !== content || retained.sha256 !== sha256)
          throw new Error("Reducer replay changed its immutable observation effect.");
        if (this.ordinal === ordinal) {
          this.written.add(digest);
          this.lastWrite =
            envelope.text_parts.length === 0 && new TextEncoder().encode(content).byteLength <= 32768
              ? { digest, content }
              : null;
        }
      },
    };
  }
}
