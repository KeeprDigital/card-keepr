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
    this.completedPrefix = true;
  }

  beginObservation() {
    this.completedPrefix = false;
    this.ordinal++;
    this.written.clear();
  }

  async seed(key: string, value: T): Promise<void> {
    this.beginObservation();
    await this.set(key, value);
  }

  async get(key: string): Promise<T | undefined> {
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
    return (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T;
  }

  /** Query only the predecessor view; call before this observation writes matching state. */
  async *matchingBeforeObservation(group: string, limit = { records: 500, bytes: 1048576 }): AsyncGenerator<T> {
    if (this.ordinal <= 1) return;
    const groupDigest = await sha256Text(group);
    let after = "";
    let bytes = 0;
    let count = 0;
    for (;;) {
      const row: (StateRow & { key_digest: string }) | null = await storage(() =>
        nextReducerGroupStateStatement(
          this.database,
          this.runId,
          this.namespace,
          groupDigest,
          this.ordinal,
          after,
        ).first<StateRow & { key_digest: string }>(),
      );
      if (!row) return;
      bytes += new TextEncoder().encode(row.content).byteLength;
      if (++count > limit.records || bytes > limit.bytes)
        throw new Error("reconciliation_capacity_exceeded: one identity match has too many candidates.");
      if ((await sha256Text(row.content)) !== row.sha256)
        throw new Error("Reducer state failed integrity verification.");
      yield (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T;
      after = row.key_digest;
    }
  }

  /** Iterate the completed observation prefix without rebuilding its complete index. */
  async *latestValues(): AsyncGenerator<T> {
    for await (const entry of this.latestEntries()) yield entry.value;
  }

  async *latestEntries(after = ""): AsyncGenerator<{ key: string; value: T }> {
    if (this.ordinal === 0) return;
    for (;;) {
      const row: (StateRow & { key_digest: string }) | null = await storage(() =>
        nextLatestReducerStateStatement(this.database, this.runId, this.namespace, this.ordinal, after).first<
          StateRow & { key_digest: string }
        >(),
      );
      if (!row) return;
      if ((await sha256Text(row.content)) !== row.sha256)
        throw new Error("Reducer state failed integrity verification.");
      yield {
        key: row.key_digest,
        value: (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T,
      };
      after = row.key_digest;
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
    const digest = await sha256Text(key);
    const envelope = await retainPartitionedRecord(this.database, this.runId, JSON.parse(JSON.stringify(value)));
    const content = canonicalJson(envelope);
    if (new TextEncoder().encode(content).byteLength > 524288)
      throw new Error("reconciliation_capacity_exceeded: one reducer fact exceeds 512 KiB.");
    const sha256 = await sha256Text(content);
    const groupDigest = this.group ? await sha256Text(this.group(value)) : null;
    const inserted = await storage(() =>
      retainReducerStateStatement(
        this.database,
        this.runId,
        this.namespace,
        digest,
        this.ordinal,
        content,
        sha256,
        groupDigest,
      ).first<StateRow>(),
    );
    const retained =
      inserted ??
      (await storage(() =>
        exactReducerStateStatement(this.database, this.runId, this.namespace, digest, this.ordinal).first<StateRow>(),
      ));
    if (retained?.content !== content || retained.sha256 !== sha256)
      throw new Error("Reducer replay changed its immutable observation effect.");
    this.written.add(digest);
  }
}
