import { createHash } from "node:crypto";
import { canonicalJson, compareUtf8, utf8 } from "../shared";

type Header = Record<string, unknown> & { id: string };

/** Two passes retain the parsed values, but never a whole serialized observation set. */
export function prepareObservationDocument(header: Header, observations: readonly unknown[]) {
  const keys = [...Object.keys(header), "observations"].sort(compareUtf8);
  const observationCount = observations.length;
  function* pieces() {
    yield utf8("{");
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      yield utf8(`${index ? "," : ""}${canonicalJson(key)}:`);
      if (key !== "observations") yield utf8(canonicalJson(header[key]));
      else {
        yield utf8("[");
        for (let ordinal = 0; ordinal < observationCount; ordinal++) {
          if (ordinal) yield utf8(",");
          if (!(ordinal in observations)) continue;
          yield utf8(
            canonicalJson({
              id: `srcobs_${header.id.slice(10)}_${ordinal + 1}`,
              ordinal: ordinal + 1,
              value: observations[ordinal],
            }),
          );
        }
        yield utf8("]");
      }
    }
    yield utf8("}");
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  for (const bytes of pieces()) {
    byteLength += bytes.byteLength;
    hash.update(bytes);
  }
  return {
    byteLength,
    digest: hash.digest("hex"),
    observationCount,
    body() {
      const iterator = pieces();
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel() {
          iterator.return();
        },
      });
    },
  };
}
