import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { retainPartitionedRecord, restorePartitionedRecord } from "./reconciliation-text";
import {
  nextLatestReducerStateStatement,
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
async function storage<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    throw new ReconciliationReducerStorageError(cause);
  }
}

type StateRow = { content: string; sha256: string };

/** A replay sees its predecessor state, even when later observations already have retained effects. */
export class ReconciliationReducerIndex<T> {
  private ordinal = 0;
  private written = new Set<string>();
  constructor(
    private database: CatalogueStore,
    private runId: string,
    private namespace: string,
    private group?: (value: T) => string,
  ) {}

  beginObservation() {
    this.ordinal++;
    this.written.clear();
  }

  async get(key: string): Promise<T | undefined> {
    const digest = await sha256Text(key);
    const row = await storage(
      reducerStateStatement(
        this.database,
        this.runId,
        this.namespace,
        digest,
        this.ordinal + (this.written.has(digest) ? 1 : 0),
      ).first<StateRow>(),
    );
    if (!row) return undefined;
    if ((await sha256Text(row.content)) !== row.sha256) throw new Error("Reducer state failed integrity verification.");
    return (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T;
  }

  /** Query only the predecessor view; call before this observation writes matching state. */
  async *matchingBeforeObservation(group: string): AsyncGenerator<T> {
    const groupDigest = await sha256Text(group);
    let after = "";
    let bytes = 0;
    let count = 0;
    for (;;) {
      const row: (StateRow & { key_digest: string }) | null = await storage(
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
      if (++count > 500 || bytes > 1048576)
        throw new Error("reconciliation_capacity_exceeded: one identity match has too many candidates.");
      if ((await sha256Text(row.content)) !== row.sha256)
        throw new Error("Reducer state failed integrity verification.");
      yield (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T;
      after = row.key_digest;
    }
  }

  /** Iterate the completed observation prefix without rebuilding its complete index. */
  async *latestValues(): AsyncGenerator<T> {
    let after = "";
    for (;;) {
      const row: (StateRow & { key_digest: string }) | null = await storage(
        nextLatestReducerStateStatement(this.database, this.runId, this.namespace, this.ordinal, after).first<
          StateRow & { key_digest: string }
        >(),
      );
      if (!row) return;
      if ((await sha256Text(row.content)) !== row.sha256)
        throw new Error("Reducer state failed integrity verification.");
      yield (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as T;
      after = row.key_digest;
    }
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
    const previous = await storage(
      exactReducerStateStatement(this.database, this.runId, this.namespace, digest, this.ordinal).first<StateRow>(),
    );
    if (!previous)
      await storage(
        retainReducerStateStatement(
          this.database,
          this.runId,
          this.namespace,
          digest,
          this.ordinal,
          content,
          sha256,
          this.group ? await sha256Text(this.group(value)) : null,
        ).run(),
      );
    const retained =
      previous ??
      (await storage(
        exactReducerStateStatement(this.database, this.runId, this.namespace, digest, this.ordinal).first<StateRow>(),
      ));
    if (retained?.content !== content || retained.sha256 !== sha256)
      throw new Error("Reducer replay changed its immutable observation effect.");
    this.written.add(digest);
  }
}
