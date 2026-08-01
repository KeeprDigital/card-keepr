import { Deflate, GZheader, zlibDeflateSetHeader } from "pako";

const zFixed = 4;
const zOk = 0;

function deterministicCompressor(): Deflate {
  const compressor = new Deflate({
    gzip: true,
    level: 9,
    windowBits: 15,
    memLevel: 8,
    strategy: zFixed,
  });
  compressor.onStart = (stream) => {
    const header = new GZheader();
    header.time = 0;
    header.os = 0xff;
    if (zlibDeflateSetHeader(stream, header) !== zOk) {
      throw new Error("The deterministic gzip header was rejected.");
    }
  };
  return compressor;
}

function push(
  compressor: Deflate,
  chunk: Uint8Array,
  final: boolean,
): void {
  if (!compressor.push(chunk, final) || compressor.err !== zOk) {
    throw new Error(
      compressor.msg || "The deterministic gzip compressor failed.",
    );
  }
}

export function deterministicGzip(value: Uint8Array): Uint8Array {
  const compressor = deterministicCompressor();
  push(compressor, value, true);
  return Uint8Array.from(compressor.result);
}

export function deterministicGzipStream(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const compressor = deterministicCompressor();
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        compressor.onData = (chunk) => controller.enqueue(chunk.slice());
      },
      transform(chunk) {
        push(compressor, chunk, false);
      },
      flush() {
        push(compressor, new Uint8Array(), true);
      },
    }),
  );
}
