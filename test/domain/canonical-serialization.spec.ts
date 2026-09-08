import { expect, test } from "vitest";
import { canonicalJson, compareUtf8 } from "../../src/catalogue/shared/serialization";

test("canonical key ordering agrees with NFC UTF-8 bytes across ASCII and Unicode", () => {
  const keys = [
    "",
    "id",
    "id2",
    "id10",
    "ID",
    "game_data",
    "a\u0000",
    "a\u007f",
    "é",
    "e\u0301",
    "\u0080",
    "\ud800",
    "\udfff",
    "\ufffd",
    "\ue000",
    "😀",
    "𐀀",
    ...Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)),
  ];
  for (const left of keys) {
    for (const right of keys) {
      const byteOrder = Buffer.compare(Buffer.from(left.normalize("NFC")), Buffer.from(right.normalize("NFC")));
      expect(Math.sign(compareUtf8(left, right))).toBe(Math.sign(byteOrder));
    }
  }
  expect(canonicalJson({ z: 1, é: 2, a: 3, "😀": 4, "\ue000": 5 })).toBe('{"a":3,"z":1,"é":2,"":5,"😀":4}');
});

test("direct canonical UTF-8 preserves reference bytes across JSON and Unicode boundaries", async () => {
  const { canonicalUtf8 } = await import("../support/canonical-utf8-prototype");
  const { utf8 } = await import("../../src/catalogue/shared/serialization");
  const strings = [
    "",
    "plain",
    '"\\\n\r\t\b\f\u0000',
    "e\u0301",
    "é",
    "😀",
    "\ud800",
    "\udfff",
    "x".repeat(32767) + "😀",
    "x".repeat(32767) + "\ud800!",
    "e\u0301".repeat(40000),
  ];
  const sparse = new Array(3);
  sparse[0] = 1;
  sparse[2] = 3;
  const values: unknown[] = [
    null,
    true,
    false,
    0,
    -0,
    1,
    Number.MAX_SAFE_INTEGER,
    1e100,
    [],
    {},
    new Array(3),
    sparse,
    ...strings,
  ];
  for (const key of strings)
    values.push({ [key]: strings, nested: [{ number: -0 }, { "\ue000": 1, "😀": 2, "e\u0301": 3, é: 4 }] });
  for (const value of values) {
    const expected = utf8(canonicalJson(value));
    const actual = canonicalUtf8(value);
    expect(actual.byteLength).toBe(expected.byteLength);
    expect(Buffer.compare(actual, expected)).toBe(0);
  }
});

test("direct canonical UTF-8 preserves unsupported-value and cycle error contracts", async () => {
  const { canonicalUtf8 } = await import("../support/canonical-utf8-prototype");
  const { utf8 } = await import("../../src/catalogue/shared/serialization");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const arrayCycle: unknown[] = [];
  arrayCycle.push(arrayCycle);
  const errors = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      return { name: (error as Error).name, message: (error as Error).message };
    }
    throw new Error("Expected encoding failure");
  };
  for (const value of [
    undefined,
    Symbol("invalid"),
    1n,
    () => 0,
    NaN,
    Infinity,
    -Infinity,
    0.5,
    { nested: [{ value: undefined }] },
    { nested: [NaN] },
    cycle,
    arrayCycle,
  ]) {
    expect(errors(() => canonicalUtf8(value))).toEqual(errors(() => utf8(canonicalJson(value))));
  }
});

test("direct canonical UTF-8 agrees with deterministic nested reference corpus", async () => {
  const { canonicalUtf8 } = await import("../support/canonical-utf8-prototype");
  const { utf8 } = await import("../../src/catalogue/shared/serialization");
  let state = 233;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const value = (depth: number): unknown => {
    const choice = next() % 6;
    if (depth && choice === 0) return Array.from({ length: next() % 5 }, () => value(depth - 1));
    if (depth && choice === 1)
      return Object.fromEntries(
        Array.from({ length: next() % 5 }, () => [String.fromCharCode(next() % 65536), value(depth - 1)]),
      );
    if (choice === 2) return String.fromCharCode(...Array.from({ length: next() % 80 }, () => next() % 65536));
    if (choice === 3) return next() % 2 === 0;
    return choice === 4 ? null : next() - 2147483648;
  };
  for (let index = 0; index < 500; index++) {
    const input = value(4);
    expect(Buffer.compare(canonicalUtf8(input), utf8(canonicalJson(input)))).toBe(0);
  }
});
