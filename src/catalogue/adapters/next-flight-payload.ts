import { AdapterParseFailure, withAdapterParseFailure } from "./adapter-parse-failure";

// Next.js app-router pages embed their React Server Components "flight" payload
// as `self.__next_f.push([1,"..."])` script chunks. Each decoded line is
// `<id>:<payload>`; element payloads are JSON arrays `["$", type, key, props]`
// whose `"$L<id>"` / `"$<id>"` strings reference other lines. This decoder is a
// bounded pure function over retained bytes: it never executes page scripts.

export type FlightElement = readonly ["$", string, string | null, Record<string, unknown>];
export type FlightChunks = ReadonlyMap<string, unknown>;

const limits = { maximumFlightCharacters: 4 * 1024 * 1024, maximumChunks: 8192, maximumDepth: 96 };
const pushPattern = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/gu;
const reference = /^\$L?([0-9a-f]+)$/u;

export function decodeFlightPayload(html: string): FlightChunks {
  let flight = "";
  for (const match of html.matchAll(pushPattern)) {
    flight += withAdapterParseFailure(() => JSON.parse(`"${match[1]}"`) as string);
    if (flight.length > limits.maximumFlightCharacters)
      throw new AdapterParseFailure("Next.js flight payload exceeds its decoding bound.");
  }
  if (!flight) throw new AdapterParseFailure("The page carries no Next.js flight payload.");
  const chunks = new Map<string, unknown>();
  let offset = 0;
  while (offset < flight.length) {
    const separator = flight.indexOf(":", offset);
    const lineEnd = flight.indexOf("\n", offset);
    if (separator === -1 || (lineEnd !== -1 && separator > lineEnd)) {
      if (flight.slice(offset, lineEnd === -1 ? undefined : lineEnd).trim())
        throw new AdapterParseFailure("Next.js flight line has no chunk identifier.");
      offset = lineEnd === -1 ? flight.length : lineEnd + 1;
      continue;
    }
    const id = flight.slice(offset, separator);
    if (id === "") {
      // Resource hints (`:HL[...]`) carry no chunk identifier and no data.
      offset = lineEnd === -1 ? flight.length : lineEnd + 1;
      continue;
    }
    if (!/^[0-9a-f]+$/u.test(id)) throw new AdapterParseFailure("Next.js flight chunk identifier is invalid.");
    if (chunks.size >= limits.maximumChunks)
      throw new AdapterParseFailure("Next.js flight payload exceeds its chunk bound.");
    const kind = flight[separator + 1];
    let end: number;
    if (kind === "T") {
      // Text chunk: `T<hex length>,<text>`; the text may span raw newlines.
      const comma = flight.indexOf(",", separator + 2);
      const length = Number.parseInt(flight.slice(separator + 2, comma), 16);
      if (comma === -1 || !Number.isSafeInteger(length) || length < 0)
        throw new AdapterParseFailure("Next.js flight text chunk length is invalid.");
      const text = textByByteLength(flight, comma + 1, length);
      chunks.set(id, text.value);
      end = text.end;
    } else {
      end = lineEnd === -1 ? flight.length : lineEnd;
      const body = flight.slice(separator + 1, end);
      if (kind === "I" || kind === "H") chunks.set(id, { $module: body });
      else
        chunks.set(
          id,
          withAdapterParseFailure(() => JSON.parse(body) as unknown),
        );
    }
    offset = flight[end] === "\n" ? end + 1 : end;
  }
  return chunks;
}

function textByByteLength(flight: string, start: number, bytes: number) {
  const encoder = new TextEncoder();
  let consumed = 0,
    end = start;
  while (consumed < bytes && end < flight.length) {
    const point = flight.codePointAt(end)!;
    consumed += encoder.encode(String.fromCodePoint(point)).byteLength;
    end += point > 0xffff ? 2 : 1;
  }
  if (consumed !== bytes) throw new AdapterParseFailure("Next.js flight text chunk is truncated.");
  return { value: flight.slice(start, end), end };
}

/** Replace chunk references with their values; module references stay as strings. */
export function resolveFlightReferences(chunks: FlightChunks, value: unknown, depth = 0): unknown {
  if (depth > limits.maximumDepth) throw new AdapterParseFailure("Next.js flight payload nesting is excessive.");
  if (typeof value === "string") {
    const match = reference.exec(value);
    if (match === null) return value;
    const target = chunks.get(match[1]!);
    if (target === undefined || (isRecord(target) && "$module" in target)) return value;
    return resolveFlightReferences(chunks, target, depth + 1);
  }
  if (Array.isArray(value)) return value.map((entry) => resolveFlightReferences(chunks, entry, depth + 1));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveFlightReferences(chunks, entry, depth + 1)]),
    );
  return value;
}

export function isFlightElement(value: unknown): value is FlightElement {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value[0] === "$" &&
    typeof value[1] === "string" &&
    (value[2] === null || typeof value[2] === "string") &&
    isRecord(value[3])
  );
}

/** Elements in document order whose props satisfy the predicate, including nested ones. */
export function flightElements(value: unknown, predicate: (element: FlightElement) => boolean): FlightElement[] {
  const found: FlightElement[] = [];
  const visit = (current: unknown, depth: number) => {
    if (depth > limits.maximumDepth) throw new AdapterParseFailure("Next.js flight payload nesting is excessive.");
    if (isFlightElement(current)) {
      if (predicate(current)) found.push(current);
      visit(current[3].children, depth + 1);
      return;
    }
    if (Array.isArray(current)) for (const entry of current) visit(entry, depth + 1);
    else if (isRecord(current)) for (const entry of Object.values(current)) visit(entry, depth + 1);
  };
  visit(value, 0);
  return found;
}

/** Visible text: strings in order, with images contributing their alt text. */
export function flightText(value: unknown, depth = 0): string {
  if (depth > limits.maximumDepth) throw new AdapterParseFailure("Next.js flight payload nesting is excessive.");
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (isFlightElement(value)) {
    if (value[1] === "img") return typeof value[3].alt === "string" ? value[3].alt : "";
    return flightText(value[3].children, depth + 1);
  }
  if (Array.isArray(value)) return value.map((entry) => flightText(entry, depth + 1)).join("");
  return "";
}

export function flightChildren(element: FlightElement): unknown[] {
  const children = element[3].children;
  if (children === undefined || children === null || children === false) return [];
  return Array.isArray(children) ? children : [children];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
