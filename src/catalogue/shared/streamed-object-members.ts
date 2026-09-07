/** Read one top-level array element at a time; large catalogues never need a joined JSON string. */
export type ObjectMember =
  | { kind: "array"; key: string }
  | { kind: "value"; key: string; array: boolean; value: unknown };

export async function* streamedObjectMembers(source: AsyncIterable<string>): AsyncGenerator<ObjectMember> {
  for await (const entry of resumableObjectMembers(() => source)) yield entry.member;
}

export type ObjectMemberCursor = {
  chunkIndex: number;
  offset: number;
  keys: string[];
  key: string;
  state: "start" | "key" | "array_value" | "array_separator" | "object_separator";
};

/** Resume at an exact token boundary in immutable, independently addressable chunks. */
export async function* resumableObjectMembers(
  source: (chunkIndex: number) => AsyncIterable<string>,
  after: ObjectMemberCursor | null = null,
  options: { maximumTokenCharacters?: number } = {},
): AsyncGenerator<{ member: ObjectMember; cursor: ObjectMemberCursor }> {
  const input = new JsonChunks(
    source(after?.chunkIndex ?? 0)[Symbol.asyncIterator](),
    after?.chunkIndex,
    after?.offset,
    options.maximumTokenCharacters,
  );
  const keys = new Set(after?.keys);
  let key = after?.key ?? "";
  let state = after?.state ?? "start";
  const entry = (member: ObjectMember) => ({ member, cursor: { ...input.position, keys: [...keys], key, state } });
  try {
    if (state === "start") {
      await input.require("{");
      if ((await input.peek()) === "}") {
        input.advance();
        if ((await input.peek()) !== undefined) throw new Error("A retained payload contains trailing data.");
        return;
      }
      state = "key";
    }
    while (true) {
      if (state === "key") {
        if ((await input.peek()) !== '"') throw new Error("A retained payload member requires a JSON key.");
        const value: unknown = JSON.parse(await input.token());
        if (typeof value !== "string" || keys.has(value))
          throw new Error("A retained payload contains an invalid or duplicate key.");
        key = value;
        keys.add(key);
        await input.require(":");
        if ((await input.peek()) === "[") {
          input.advance();
          state = "array_value";
          yield entry({ kind: "array", key });
        } else {
          const value = JSON.parse(await input.token());
          state = "object_separator";
          yield entry({ kind: "value", key, array: false, value });
        }
      } else if (state === "array_value") {
        if ((await input.peek()) === "]") {
          input.advance();
          state = "object_separator";
        } else {
          const value = JSON.parse(await input.token());
          state = "array_separator";
          yield entry({ kind: "value", key, array: true, value });
        }
      } else if (state === "array_separator") {
        if ((await input.peek()) === "]") {
          input.advance();
          state = "object_separator";
        } else {
          await input.require(",");
          // A trailing comma cannot be accepted as an empty suffix.
          if ((await input.peek()) === "]") throw new Error("A retained payload contains a trailing comma.");
          state = "array_value";
        }
      } else {
        if ((await input.peek()) === "}") {
          input.advance();
          if ((await input.peek()) !== undefined) throw new Error("A retained payload contains trailing data.");
          return;
        }
        await input.require(",");
        state = "key";
      }
    }
  } finally {
    await input.close();
  }
}

class JsonChunks {
  private chunk = "";
  private offset = 0;
  private ended = false;
  private chunkIndex: number;
  private initialOffset: number;
  constructor(
    private readonly source: AsyncIterator<string>,
    chunkIndex = 0,
    offset = 0,
    private readonly maximumTokenCharacters = Number.POSITIVE_INFINITY,
  ) {
    this.chunkIndex = chunkIndex - 1;
    this.initialOffset = offset;
  }
  get position() {
    return { chunkIndex: this.chunkIndex, offset: this.offset };
  }

  async close(): Promise<void> {
    await this.source.return?.();
  }

  private async available(): Promise<boolean> {
    while (this.offset === this.chunk.length && !this.ended) {
      const next = await this.source.next();
      this.ended = next.done === true;
      this.chunk = next.value ?? "";
      this.offset = this.initialOffset;
      this.initialOffset = 0;
      this.chunkIndex++;
      if (this.offset > this.chunk.length) throw new Error("A retained payload cursor exceeds its chunk.");
    }
    return this.offset < this.chunk.length;
  }

  async peek(): Promise<string | undefined> {
    while (await this.available()) {
      const character = this.chunk.charAt(this.offset);
      if (!" \t\r\n".includes(character)) return character;
      this.offset += 1;
    }
    return undefined;
  }

  advance(): void {
    this.offset += 1;
  }

  async require(character: string): Promise<void> {
    if ((await this.peek()) !== character) throw new Error(`A retained payload requires ${character}.`);
    this.advance();
  }

  async token(): Promise<string> {
    if ((await this.peek()) === undefined) throw new Error("A retained payload is incomplete.");
    const parts: string[] = [];
    let characters = 0;
    const append = (value: string) => {
      characters += value.length;
      if (characters > this.maximumTokenCharacters)
        throw new Error("reconciliation_capacity_exceeded: one source JSON token exceeds its character budget.");
      parts.push(value);
    };
    let depth = 0;
    let quoted = false;
    let escaped = false;
    while (await this.available()) {
      const start = this.offset;
      while (this.offset < this.chunk.length) {
        const character = this.chunk.charAt(this.offset);
        if (!quoted && depth === 0 && ",:]} \t\r\n".includes(character)) {
          append(this.chunk.slice(start, this.offset));
          return parts.join("");
        }
        this.offset += 1;
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') {
            quoted = false;
            if (depth === 0) {
              append(this.chunk.slice(start, this.offset));
              return parts.join("");
            }
          }
        } else if (character === '"') quoted = true;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") {
          depth -= 1;
          if (depth === 0) {
            append(this.chunk.slice(start, this.offset));
            return parts.join("");
          }
        }
      }
      append(this.chunk.slice(start, this.offset));
    }
    return parts.join("");
  }
}
