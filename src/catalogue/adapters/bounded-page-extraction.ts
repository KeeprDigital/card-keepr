import { Tokenizer, TokenizerMode, type TokenHandler } from "parse5";
import { resumableObjectMembers, ObjectMemberParseFailure, utf8 } from "../shared";
import { AdapterParseFailure } from "./adapter-parse-failure";
import type { SourceAdapterRegistration } from "./source-adapter-registration-types";

const maximumDecodedCharacters = 2097152;
const maximumHtmlTags = 32768;

/** HTML remains an explicitly capped page parser; no run/lineage input reaches it. */
async function extractPage(
  adapter: SourceAdapterRegistration,
  source: () => AsyncIterable<string>,
  context: { url: string; mediaType: string | null; requestId?: string },
) {
  if (adapter.parseBytes === undefined) return extractJsonRecords(adapter, source);
  let html = "",
    tags = 0,
    attributes = 0;
  const scripts: string[] = [];
  const tokenizerFor = (collectScripts: boolean) => {
    let script: string | null = null;
    const finish = () => {
      if (script !== null) scripts.push(script);
      script = null;
    };
    const characters: TokenHandler["onCharacter"] = (token) => {
      if (script !== null) script += token.chars;
    };
    const ignore = () => {};
    const tokenizer = new Tokenizer(
      {},
      {
        onStartTag(token) {
          attributes += token.attrs.length;
          if (++tags > maximumHtmlTags || attributes > 65536)
            throw new AdapterParseFailure("Official HTML page exceeds its element/attribute construction budget.");
          if (token.tagName === "script") {
            tokenizer.state = TokenizerMode.SCRIPT_DATA;
            if (
              collectScripts &&
              token.attrs.some(
                (attribute) =>
                  (attribute.name === "type" && attribute.value === "application/json") ||
                  (attribute.name === "id" && attribute.value === "__NEXT_DATA__"),
              )
            )
              script = "";
          } else if (token.tagName === "style") tokenizer.state = TokenizerMode.RAWTEXT;
        },
        onEndTag(token) {
          if (token.tagName === "script") finish();
        },
        onEof: finish,
        onCharacter: characters,
        onWhitespaceCharacter: characters,
        onNullCharacter: characters,
        onComment: ignore,
        onDoctype: ignore,
      },
    );
    return tokenizer;
  };
  const tokenizer = tokenizerFor(true);
  for await (const chunk of source()) {
    if (html.length + chunk.length > maximumDecodedCharacters)
      throw new AdapterParseFailure("Official HTML page exceeds 4 MiB of decoded UTF-16 text.");
    tokenizer.write(chunk, false);
    html += chunk;
  }
  tokenizer.write("", true);
  // Validate embedded publisher JSON token/depth bounds before the existing
  // page parser constructs its publisher object or semantic record arrays.
  for (const script of scripts) {
    const embedded = script.trim();
    const value = embedded.startsWith("[") ? `{ "records": ${embedded} }` : embedded;
    if (!value.startsWith("{")) continue;
    let values = 0;
    for await (const { member } of resumableObjectMembers(() => oneChunk(value), null, {
      maximumTokenBytes: 4194304,
      maximumTokenCharacters: 2097152,
      maximumStructuralTokens: 16384,
      maximumDepth: 128,
    })) {
      if (++values > 2048) throw new AdapterParseFailure("Publisher JSON exceeds the page record construction budget.");
      const checkRichText = (value: unknown): void => {
        if (typeof value === "string" && value.includes("<")) tokenizerFor(false).write(value, true);
        else if (Array.isArray(value)) value.forEach(checkRichText);
        else if (value !== null && typeof value === "object") Object.values(value).forEach(checkRichText);
      };
      if (member.kind === "value") checkRichText(member.value);
    }
  }
  const bytes = utf8(html);
  const observations = await adapter.parseBytes(bytes, context);
  if (observations.length > 2048) throw new AdapterParseFailure("Official HTML page produces too many records.");
  return {
    count: observations.length,
    pagination: null,
    requests: (async function* () {
      yield* adapter.discoverRequests?.(bytes, context) ?? [];
    })(),
    records: (async function* () {
      for (let index = 0; index < observations.length; index++)
        yield { sourceKey: String(index), value: observations[index], request: null };
    })(),
  };
}
async function* oneChunk(value: string) {
  yield value;
}

/** Synthetic/admitted JSON adapters transform one source record at a time. */
async function extractJsonRecords(adapter: SourceAdapterRegistration, source: () => AsyncIterable<string>) {
  if (!adapter.parse) throw new Error("Source adapter parser is missing.");
  const containers = adapter.jsonRecordContainers ?? [];
  if (containers.length > 32 || new Set(containers).size !== containers.length)
    throw new Error("Source adapter record containers must be a bounded ordered vocabulary.");
  const limits = {
    maximumTokenBytes: 16777216,
    maximumTokenCharacters: 16777216,
    maximumStructuralTokens: 16384,
    maximumDepth: 128,
  };
  let count = 0,
    members = 0;
  const arrays = new Set<string>();
  for await (const { member } of checkedMembers(source, limits)) {
    if (++members > 32768) throw new AdapterParseFailure("Source JSON page exceeds its member budget.");
    if (containers.includes(member.key)) {
      if (member.kind === "array") arrays.add(member.key);
      if (member.kind === "value" && member.array && ++count > 2048)
        throw new AdapterParseFailure("Source JSON page exceeds 2048 records.");
    }
  }
  if (!arrays.size) {
    // Some admitted adapters accept a single unwrapped observation. Its entire
    // object is one explicitly bounded record, never an implicit empty page.
    let json = "";
    for await (const chunk of source()) {
      if (json.length + chunk.length > 16777216)
        throw new AdapterParseFailure("Single source JSON record exceeds its character budget.");
      json += chunk;
    }
    const values = await adapter.parse(JSON.parse(json));
    if (values.length > 2048) throw new AdapterParseFailure("Source JSON page exceeds 2048 records.");
    return {
      count: values.length,
      pagination: null,
      requests: [],
      records: (async function* () {
        for (const [index, value] of values.entries()) yield { sourceKey: String(index), value, request: null };
      })(),
    };
  }
  return {
    count,
    pagination: null,
    requests: [],
    records: (async function* () {
      let ordinal = 0;
      // Preserve the admitted parser's cards-before-products observation order,
      // even when the publisher document places the arrays in another order.
      for (const key of containers.filter((key) => arrays.has(key)))
        for await (const { member } of checkedMembers(source, limits)) {
          if (member.kind !== "value" || !member.array || member.key !== key) continue;
          const parsed = await adapter.parse!({ [key]: [member.value] });
          if (parsed.length !== 1) throw new AdapterParseFailure("One source record must produce one observation.");
          yield { sourceKey: String(ordinal++), value: parsed[0], request: null };
        }
    })(),
  };
}
async function* checkedMembers(
  source: () => AsyncIterable<string>,
  limits: Parameters<typeof resumableObjectMembers>[2],
) {
  try {
    yield* resumableObjectMembers(() => source(), null, limits);
  } catch (error) {
    if (error instanceof ObjectMemberParseFailure || error instanceof SyntaxError)
      throw new AdapterParseFailure(error.message, { cause: error });
    throw error;
  }
}
export async function extractBoundedAdapterPage(...args: Parameters<typeof extractPage>) {
  try {
    return await extractPage(...args);
  } catch (error) {
    if (error instanceof ObjectMemberParseFailure || error instanceof SyntaxError)
      throw new AdapterParseFailure(error.message, { cause: error });
    throw error;
  }
}
