import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { gzipJsonlBlocks, gzipJsonlRecords } from "../../src/catalogue/shared/gzip-jsonl";

test("derived blocks preserve exact source byte and record positions across a boundary", async () => {
  const raw = Buffer.from('{"name":"Æther"}\n{"name":"two"}\n{"name":"three"}');
  const compressed = gzipSync(raw);
  const blocks = [];
  for await (const block of gzipJsonlBlocks(
    (async function* () {
      yield compressed;
    })(),
    {
      compressedBytes: 1024,
      decompressedBytes: 1024,
      recordBytes: 32,
      records: 3,
    },
    40,
    2,
  ))
    blocks.push(block);
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toMatchObject({ ordinal: 0, offset: 0, firstRecord: 0, recordCount: 2 });
  expect(blocks[1]).toMatchObject({ ordinal: 1, offset: blocks[0]!.bytes.length, firstRecord: 2, recordCount: 1 });
  expect(Buffer.concat(blocks.map(({ bytes }) => bytes))).toEqual(raw);
});

test("gzip JSONL decoding retains exact record bytes across compressed and UTF-8 boundaries", async () => {
  const raw = readFileSync(
    new URL("../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/split-three.json", import.meta.url),
  );
  const compressed = gzipSync(raw);
  const records = [];
  for await (const record of gzipJsonlRecords(
    (async function* () {
      for (let offset = 0; offset < compressed.length; offset += 7) yield compressed.subarray(offset, offset + 7);
    })(),
    { compressedBytes: compressed.length, decompressedBytes: raw.length, recordBytes: 128 * 1024, records: 1 },
  ))
    records.push(record);
  expect(records).toEqual([{ ordinal: 0, offset: 0, bytes: new Uint8Array(raw) }]);
});

test.each(["checksum", "truncated", "trailing"])(
  "gzip %s corruption never completes a source archive",
  async (kind) => {
    let compressed = gzipSync(Buffer.from('{"name":"Æther"}\n'));
    if (kind === "checksum") compressed[compressed.length - 8]! ^= 1;
    if (kind === "truncated") compressed = compressed.subarray(0, compressed.length - 1);
    if (kind === "trailing") compressed = Buffer.concat([compressed, Buffer.from("garbage")]);
    await expect(
      (async () => {
        for await (const _record of gzipJsonlRecords(
          (async function* () {
            yield compressed;
          })(),
          {
            compressedBytes: 1024,
            decompressedBytes: 1024,
            recordBytes: 128,
            records: 2,
          },
        )) {
          /* Consuming EOF is necessary before any observation can be sealed. */
        }
      })(),
    ).rejects.toThrow();
  },
);

test.each(["compressedBytes", "decompressedBytes", "recordBytes", "records"] as const)(
  "%s is an independent archive bound",
  async (limit) => {
    const compressed = gzipSync(Buffer.from('{"name":"one"}\n{"name":"two"}\n'));
    await expect(
      (async () => {
        for await (const _record of gzipJsonlRecords(
          (async function* () {
            yield compressed;
          })(),
          {
            compressedBytes: 1024,
            decompressedBytes: 1024,
            recordBytes: 128,
            records: 2,
            [limit]: 1,
          },
        )) {
          /* No successful archive receipt may escape a bound violation. */
        }
      })(),
    ).rejects.toThrow();
  },
);
