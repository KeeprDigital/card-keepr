import { describe, expect, it } from "vitest";
import { streamedObjectMembers } from "../../src/catalogue/shared/streamed-object-members";

async function* chunks(value: string, size: number) {
  for (let offset = 0; offset < value.length; offset += size) yield value.slice(offset, offset + size);
}

async function read(value: string, size: number) {
  const result: Record<string, unknown> = {};
  for await (const member of streamedObjectMembers(chunks(value, size))) {
    if (member.kind === "array") result[member.key] = [];
    else if (member.array) (result[member.key] as unknown[]).push(member.value);
    else result[member.key] = member.value;
  }
  return result;
}

describe("streamed retained candidate JSON", () => {
  it.each([1, 2, 7, 512])(
    "preserves nested records, escaped strings and headers across %i-character chunks",
    async (size) => {
      const candidate = {
        contract: "candidate@1",
        cards: [{ name: 'A \\"quoted" card 🃏', game_data: { list: [null, false, 4.2, "a,b]}\\"] } }],
        empty: [],
        identity_corrections: { decision: ["x", "y"] },
      };
      expect(await read(JSON.stringify(candidate), size)).toEqual(candidate);
    },
  );

  it.each([
    '{"cards":[{}',
    '{"cards":[{},]}',
    '{"cards":[]} trailing',
    '{"cards":[] "x":1}',
    '{"cards":[],}',
    '{"cards":[],"cards":[]}',
  ])("rejects malformed or ambiguous retained payload %s", async (value) => {
    await expect(read(value, 2)).rejects.toThrow();
  });

  it("yields a record before reading the remaining catalogue", async () => {
    let continued = false;
    async function* source() {
      yield '{"cards":[{"id":"first"},';
      continued = true;
      yield '{"id":"second"}]}';
    }
    const members = streamedObjectMembers(source());
    expect((await members.next()).value).toEqual({ kind: "array", key: "cards" });
    expect((await members.next()).value).toEqual({ kind: "value", key: "cards", array: true, value: { id: "first" } });
    expect(continued).toBe(false);
    await members.return(undefined);
  });
});
