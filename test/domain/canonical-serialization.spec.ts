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
