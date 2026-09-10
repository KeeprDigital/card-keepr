type Dimensions = { width: number; height: number };

// Preserve the existing PNG/GIF/WebP header, JPEG frame, and AVIF ispe
// recognition while keeping only a fixed header window across stream chunks.
export function printingImageDimensions(mediaType: string) {
  const header = new Uint8Array(30);
  let used = 0;
  let dimensions: Dimensions | null = null;
  const jpeg = jpegDimensions();
  const avif = avifDimensions();
  return {
    write(bytes: Uint8Array) {
      if (dimensions !== null) return;
      const count = Math.min(header.length - used, bytes.length);
      header.set(bytes.subarray(0, count), used);
      used += count;
      if (mediaType === "image/jpeg" || mediaType === "image/jpg") dimensions = jpeg.write(bytes);
      if (mediaType === "image/avif") dimensions = avif.write(bytes);
      const view = new DataView(header.buffer);
      if (
        mediaType === "image/png" &&
        used >= 24 &&
        header[0] === 0x89 &&
        header[1] === 0x50 &&
        header[2] === 0x4e &&
        header[3] === 0x47
      ) {
        dimensions = { width: view.getUint32(16), height: view.getUint32(20) };
      }
      if (mediaType === "image/gif" && used >= 10 && text(header, 0, 3) === "GIF") {
        dimensions = { width: view.getUint16(6, true), height: view.getUint16(8, true) };
      }
      if (mediaType === "image/webp" && used >= 30 && text(header, 0, 4) === "RIFF" && text(header, 8, 12) === "WEBP") {
        const chunk = text(header, 12, 16);
        if (chunk === "VP8X") dimensions = { width: 1 + uint24le(header, 24), height: 1 + uint24le(header, 27) };
        if (chunk === "VP8 ")
          dimensions = { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
        if (chunk === "VP8L" && header[20] === 0x2f) {
          const bits = view.getUint32(21, true);
          dimensions = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
        }
      }
    },
    read(): Dimensions {
      if (dimensions === null) throw new Error("Retained Printing Image dimensions are unsupported.");
      return dimensions;
    },
  };
}

function text(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function avifDimensions() {
  const window = new Uint8Array(16);
  let seen = 0;
  const at = (offset: number) => window[(seen + offset) % window.length]!;
  const uint32 = (offset: number) =>
    ((at(offset) << 24) | (at(offset + 1) << 16) | (at(offset + 2) << 8) | at(offset + 3)) >>> 0;
  return {
    write(bytes: Uint8Array): Dimensions | null {
      for (const byte of bytes) {
        window[seen % window.length] = byte;
        seen += 1;
        if (seen >= 20 && at(0) === 0x69 && at(1) === 0x73 && at(2) === 0x70 && at(3) === 0x65) {
          return { width: uint32(8), height: uint32(12) };
        }
      }
      return null;
    },
  };
}

function jpegDimensions() {
  const header = new Uint8Array(9);
  let used = 0;
  let initial = true;
  let skip = 0;
  let invalid = false;
  let frame = false;
  return {
    write(bytes: Uint8Array): Dimensions | null {
      if (invalid) return null;
      for (let offset = 0; offset < bytes.length; offset += 1) {
        if (skip > 0) {
          const skipped = Math.min(skip, bytes.length - offset);
          skip -= skipped;
          offset += skipped - 1;
          continue;
        }
        const byte = bytes[offset]!;
        if (!initial && used === 0 && byte !== 0xff) continue;
        header[used++] = byte;
        if (initial && used === 2) {
          if (header[0] !== 0xff || header[1] !== 0xd8) {
            invalid = true;
            return null;
          }
          initial = false;
          used = 0;
        } else if (!initial && used === 4) {
          const marker = header[1]!;
          frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
          if (!frame) {
            const length = (header[2]! << 8) | header[3]!;
            if (length < 2) {
              invalid = true;
              return null;
            }
            skip = length - 2;
            used = 0;
          }
        } else if (frame && used === 9) {
          const view = new DataView(header.buffer);
          return { height: view.getUint16(5), width: view.getUint16(7) };
        }
      }
      return null;
    },
  };
}
