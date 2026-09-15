import { expect, test } from "vitest";
import { selectIngestionShard } from "../support/ingestion-shards";

const sourceFile = (name: string, calls: number, root = "/checkout") => ({
  path: `${root}/${name}.spec.ts`,
  source: "await collect();\n".repeat(calls),
});

test("every selected file, including new work and files without known fixtures, runs exactly once", () => {
  const files = Object.freeze([
    sourceFile("heavy", 20),
    sourceFile("middle", 3),
    sourceFile("plain", 0),
    { path: "/checkout/new.spec.ts", source: "test('new case', () => expect(true).toBe(true));" },
  ]);
  for (const count of [1, 2, 3, 4]) {
    const partitions = Array.from({ length: count }, (_, shard) =>
      selectIngestionShard(files, "/checkout", { index: shard + 1, count }),
    );
    expect(partitions.every((partition) => partition.length > 0)).toBe(true);
    expect(
      partitions
        .flat()
        .map((file) => file.path)
        .sort(),
    ).toEqual([
      "/checkout/heavy.spec.ts",
      "/checkout/middle.spec.ts",
      "/checkout/new.spec.ts",
      "/checkout/plain.spec.ts",
    ]);
    expect(partitions.flat().every((file) => files.includes(file))).toBe(true);
  }
});

test("equal-work ties keep the same path and shard order across enumeration and checkout locations", () => {
  for (const root of ["/checkout", "/different/location/checkout"]) {
    const files = ["g", "d", "f", "b", "e", "c", "a"].map((name) => sourceFile(name, 0, root));
    for (const input of [files, [...files].reverse()]) {
      const selected = [1, 2, 3].map((index) =>
        selectIngestionShard(input, root, { index, count: 3 }).map((file) => file.path.slice(root.length)),
      );
      expect(selected).toEqual([
        ["/a.spec.ts", "/d.spec.ts", "/g.spec.ts"],
        ["/b.spec.ts", "/e.spec.ts"],
        ["/c.spec.ts", "/f.spec.ts"],
      ]);
    }
  }
});

test.each([
  { index: 0, count: 1 },
  { index: 2, count: 1 },
  { index: 1.5, count: 2 },
  { index: Number.NaN, count: 1 },
  { index: 1, count: 0 },
  { index: 1, count: -1 },
  { index: 1, count: 1.5 },
  { index: 1, count: 3 },
])("invalid shard coordinates are rejected before selecting files: %j", (shard) => {
  expect(() => selectIngestionShard([sourceFile("a", 1), sourceFile("b", 1)], "/checkout", shard)).toThrow(
    new RangeError("Invalid ingestion shard selection"),
  );
});

test("native setup work is spread across shards even when equally sized selections have uneven costs", () => {
  const files = [
    sourceFile("a", 8),
    sourceFile("b", 7),
    sourceFile("c", 6),
    sourceFile("d", 5),
    sourceFile("e", 4),
    sourceFile("f", 3),
  ];
  const selected = [1, 2, 3].map((index) =>
    selectIngestionShard(files, "/checkout", { index, count: 3 }).map((file) => file.path),
  );
  // Each pair represents thirteen units: one per file plus its native setup calls.
  expect(selected).toEqual([
    ["/checkout/a.spec.ts", "/checkout/f.spec.ts"],
    ["/checkout/b.spec.ts", "/checkout/e.spec.ts"],
    ["/checkout/c.spec.ts", "/checkout/d.spec.ts"],
  ]);
});
