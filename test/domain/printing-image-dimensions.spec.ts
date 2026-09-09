import { expect, test } from "vitest";
import { printingImageDimensions } from "../../src/catalogue/reconciliation/printing-image-dimensions";

test("Printing Image dimensions survive byte-split PNG headers without retaining the image payload", () => {
  const reader = printingImageDimensions("image/png");
  const header = Buffer.from("89504e470d0a1a0a0000000d49484452000002e80000040f", "hex");
  for (const byte of header) reader.write(Uint8Array.of(byte));
  reader.write(new Uint8Array(131072));
  expect(reader.read()).toEqual({ width: 744, height: 1039 });
});

test("JPEG frame dimensions survive large skipped segments and split frame fields", () => {
  const reader = printingImageDimensions("image/jpeg");
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]),
    Buffer.alloc(65533),
    Buffer.from([0xff, 0xc0, 0, 17, 8, 4, 15, 2, 232]),
  ]);
  for (let start = 0; start < bytes.length; start += 7) reader.write(bytes.subarray(start, start + 7));
  expect(reader.read()).toEqual({ width: 744, height: 1039 });
});

test.each([
  ["image/gif", "474946383961e8020f04"],
  ["image/webp", "524946460000000057454250565038580000000000000000e702000e0400"],
  ["image/webp", "5249464600000000574542505650382000000000000000000000e8020f04"],
  ["image/webp", "5249464600000000574542505650384c000000002fe78203010000000000"],
  ["image/avif", "000000106674797069736f38000000146973706500000000000002e80000040f"],
])("%s dimensions survive split fields", (mediaType, hex) => {
  const reader = printingImageDimensions(mediaType);
  for (const byte of Buffer.from(hex, "hex")) reader.write(Uint8Array.of(byte));
  expect(reader.read()).toEqual({ width: 744, height: 1039 });
});

test.each(["image/png", "image/gif", "image/jpeg", "image/webp", "image/avif", "image/svg+xml"])(
  "%s rejects incomplete or unsupported image dimensions",
  (mediaType) => {
    const reader = printingImageDimensions(mediaType);
    reader.write(new Uint8Array(29));
    expect(() => reader.read()).toThrow("dimensions are unsupported");
  },
);
