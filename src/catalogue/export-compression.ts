import { constants, deflateRaw } from "pako";

const crc32Table = Uint32Array.from(
  { length: 256 },
  (_, byte) => {
    let value = byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return value >>> 0;
  },
);

export function deterministicGzip(value: Uint8Array): Uint8Array {
  const deflated = deflateRaw(value, {
    level: 9,
    windowBits: 15,
    memLevel: 8,
    strategy: constants.Z_FIXED,
  });
  const result = new Uint8Array(10 + deflated.byteLength + 8);
  result.set(
    [
      0x1f, 0x8b, 0x08, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x02, 0xff,
    ],
  );
  result.set(deflated, 10);
  writeUint32LittleEndian(result, 10 + deflated.byteLength, crc32(value));
  writeUint32LittleEndian(
    result,
    14 + deflated.byteLength,
    value.byteLength >>> 0,
  );
  return result;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc = crc32Table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32LittleEndian(
  target: Uint8Array,
  offset: number,
  value: number,
): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}
