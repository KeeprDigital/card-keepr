/** Every scanned item advances the cursor, including items that emit no records. */
export class ReconciliationInputSequence<T, Cursor> implements AsyncIterable<T> {
  constructor(private readonly entries: (after: Cursor | null) => AsyncGenerator<{ cursor: Cursor; records: T[] }>) {}

  async *scan(after: string | null) {
    for await (const entry of this.entries(after === null ? null : (JSON.parse(after) as Cursor)))
      yield { cursor: JSON.stringify(entry.cursor), records: entry.records };
  }

  async *[Symbol.asyncIterator]() {
    for await (const entry of this.entries(null)) yield* entry.records;
  }
}
