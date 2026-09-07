import { expect, test } from "vitest";
import { resumableObjectMembers } from "../../src/catalogue/shared/streamed-object-members";

async function read(
  value: unknown,
  options: { maximumStructuralTokens: number; maximumDepth: number; maximumTokenBytes?: number },
) {
  const text = JSON.stringify({ cards: [value] });
  const result = [];
  for await (const entry of resumableObjectMembers(
    async function* () {
      for (let offset = 0; offset < text.length; offset += 997) yield text.slice(offset, offset + 997);
    },
    null,
    { maximumTokenCharacters: 4_194_304, ...options },
  ))
    result.push(entry.member);
  return result;
}

test("dense JSON members stop before materializing unbounded object counts", async () => {
  await expect(
    read(
      { traits: Array.from({ length: 1000 }, () => ({})) },
      {
        maximumStructuralTokens: 64,
        maximumDepth: 128,
      },
    ),
  ).rejects.toThrow("structural budget");
});

test("deep JSON members stop before recursive consumers can overflow", async () => {
  let nested: unknown = 0;
  for (let depth = 0; depth < 20; depth++) nested = [nested];
  await expect(read(nested, { maximumStructuralTokens: 1000, maximumDepth: 8 })).rejects.toThrow("depth budget");
});

test("UTF-8 bytes bound a multibyte token independently of its character count", async () => {
  await expect(
    read(
      { text: "é".repeat(40) },
      {
        maximumStructuralTokens: 64,
        maximumDepth: 8,
        maximumTokenBytes: 64,
      },
    ),
  ).rejects.toThrow("byte budget");
});

test("punctuation inside long text does not consume the structural allowance", async () => {
  const value = { text: '[{},:]\\"'.repeat(20000) };
  expect(await read(value, { maximumStructuralTokens: 16, maximumDepth: 8 })).toContainEqual({
    kind: "value",
    key: "cards",
    array: true,
    value,
  });
});
