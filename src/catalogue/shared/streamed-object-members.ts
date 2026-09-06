/** Read one top-level array element at a time; large catalogues never need a joined JSON string. */
export type ObjectMember =
  | { kind: "array"; key: string }
  | { kind: "value"; key: string; array: boolean; value: unknown };

export async function* streamedObjectMembers(source: AsyncIterable<string>): AsyncGenerator<ObjectMember> {
  const input = new JsonChunks(source[Symbol.asyncIterator]());
  const keys = new Set<string>();
  try {
    await input.require("{");
    if ((await input.peek()) === "}") input.advance();
    else {
      while (true) {
        if ((await input.peek()) !== '"') throw new Error("A retained payload member requires a JSON key.");
        const key: unknown = JSON.parse(await input.token());
        if (typeof key !== "string" || keys.has(key))
          throw new Error("A retained payload contains an invalid or duplicate key.");
        keys.add(key);
        await input.require(":");
        if ((await input.peek()) === "[") {
          input.advance();
          yield { kind: "array", key };
          if ((await input.peek()) !== "]") {
            while (true) {
              yield { kind: "value", key, array: true, value: JSON.parse(await input.token()) };
              const separator = await input.peek();
              if (separator === "]") break;
              await input.require(",");
            }
          }
          await input.require("]");
        } else {
          yield { kind: "value", key, array: false, value: JSON.parse(await input.token()) };
        }
        if ((await input.peek()) === "}") {
          input.advance();
          break;
        }
        await input.require(",");
      }
    }
    if ((await input.peek()) !== undefined) throw new Error("A retained payload contains trailing data.");
  } finally {
    await input.close();
  }
}

class JsonChunks {
  private chunk = "";
  private offset = 0;
  private ended = false;
  constructor(private readonly source: AsyncIterator<string>) {}

  async close(): Promise<void> {
    await this.source.return?.();
  }

  private async available(): Promise<boolean> {
    while (this.offset === this.chunk.length && !this.ended) {
      const next = await this.source.next();
      this.ended = next.done === true;
      this.chunk = next.value ?? "";
      this.offset = 0;
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
    let depth = 0;
    let quoted = false;
    let escaped = false;
    while (await this.available()) {
      const start = this.offset;
      while (this.offset < this.chunk.length) {
        const character = this.chunk.charAt(this.offset);
        if (!quoted && depth === 0 && ",:]} \t\r\n".includes(character)) {
          parts.push(this.chunk.slice(start, this.offset));
          return parts.join("");
        }
        this.offset += 1;
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') {
            quoted = false;
            if (depth === 0) {
              parts.push(this.chunk.slice(start, this.offset));
              return parts.join("");
            }
          }
        } else if (character === '"') quoted = true;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") {
          depth -= 1;
          if (depth === 0) {
            parts.push(this.chunk.slice(start, this.offset));
            return parts.join("");
          }
        }
      }
      parts.push(this.chunk.slice(start, this.offset));
    }
    return parts.join("");
  }
}
