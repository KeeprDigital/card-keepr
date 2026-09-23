import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { ResumableGunzip, SourceArchiveFailure, type GunzipCheckpoint } from "../../src/catalogue/shared";

function source(compressed: Uint8Array, reads: { offset: number; length: number }[] = []) {
  return {
    length: compressed.byteLength,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    decompressedBytes: 1024 * 1024 * 1024,
    read: async (offset: number, length: number) => {
      reads.push({ offset, length });
      return { bytes: compressed.slice(offset, offset + length), etag: "etag" };
    },
  };
}

/** Decode, serializing and restoring the complete state after every chunk. */
async function resumedDecode(compressed: Uint8Array) {
  const chunks: Uint8Array[] = [];
  let checkpoint: { state: GunzipCheckpoint; window: Uint8Array } | undefined;
  let steps = 0;
  for (;;) {
    const decoder = new ResumableGunzip(
      source(compressed),
      checkpoint && (JSON.parse(JSON.stringify(checkpoint.state)) as GunzipCheckpoint),
      checkpoint?.window,
    );
    const chunk = await decoder.next();
    steps++;
    if (chunk === null) return { output: Buffer.concat(chunks), digest: decoder.decodedDigest, steps };
    chunks.push(chunk);
    checkpoint = decoder.checkpoint();
  }
}

// Mixed text, repeats and noise exercise literal, match, stored and dynamic blocks.
const text = Buffer.from(
  Array.from({ length: 40000 }, (_, i) => `{"id":"${i % 977}","name":"Æther ${i}","oracle":"draw ${i % 13}"}\n`).join(
    "",
  ),
);
const noisy = Buffer.concat([text.subarray(0, 300000), randomBytes(200000), text.subarray(300000)]);

test.each([
  ["stored", 0],
  ["fast", 1],
  ["default", 6],
  ["best", 9],
] as const)("%s gzip output resumes from serialized state after every chunk", async (_name, level) => {
  const compressed = gzipSync(noisy, { level });
  const result = await resumedDecode(compressed);
  expect(result.output.equals(noisy)).toBe(true);
  expect(result.digest).toBe(createHash("sha256").update(noisy).digest("hex"));
  expect(result.steps).toBeGreaterThan(noisy.byteLength / (64 * 1024));
});

test("fixed-Huffman and empty archives decode exactly", async () => {
  for (const raw of [Buffer.from('{"a":1}\n'), Buffer.alloc(0), Buffer.from("x".repeat(70000))]) {
    const result = await resumedDecode(gzipSync(raw, { strategy: 4 /* Z_FIXED */ }));
    expect(result.output.equals(raw)).toBe(true);
  }
});

test("reads are bounded compressed ranges and never repeat the retained prefix", async () => {
  const compressed = gzipSync(noisy);
  const reads: { offset: number; length: number }[] = [];
  const decoder = new ResumableGunzip(source(compressed, reads));
  while ((await decoder.next()) !== null);
  expect(reads.every(({ length }) => length <= 1024 * 1024)).toBe(true);
  expect(reads.reduce((sum, { length }) => sum + length, 0)).toBe(compressed.byteLength);
});

test.each(["checksum", "length", "truncated", "trailing", "digest"])(
  "%s corruption never completes the stream",
  async (kind) => {
    let compressed = new Uint8Array(gzipSync(text));
    if (kind === "checksum") compressed[compressed.length - 8]! ^= 1;
    if (kind === "length") compressed[compressed.length - 1]! ^= 1;
    if (kind === "truncated") compressed = compressed.subarray(0, compressed.length - 1);
    if (kind === "trailing") compressed = Buffer.concat([compressed, Buffer.from("garbage")]);
    const decoder = new ResumableGunzip(
      kind === "digest" ? { ...source(compressed), sha256: "0".repeat(64) } : source(compressed),
    );
    await expect(
      (async () => {
        while ((await decoder.next()) !== null);
      })(),
    ).rejects.toThrow(kind === "digest" ? "exact-byte verification" : SourceArchiveFailure);
  },
);

test("a changed retained object between ranges fails closed", async () => {
  const compressed = gzipSync(randomBytes(3 * 1024 * 1024), { level: 1 });
  let calls = 0;
  const decoder = new ResumableGunzip({
    ...source(compressed),
    read: async (offset, length) => ({ bytes: compressed.slice(offset, offset + length), etag: `etag-${calls++}` }),
  });
  await expect(
    (async () => {
      while ((await decoder.next()) !== null);
    })(),
  ).rejects.toThrow("changed while decoding");
});
