import { createHash } from "node:crypto";
import { type CatalogueStore, canonicalJson, sha256Text, utf8 } from "../shared";
import { AdapterParseFailure } from "../adapters";
import {
  retainSourceAuxiliary,
  sourceAuxiliaryPage,
  type SourceAuxiliaryRow,
} from "./source-record-auxiliary-repository";
type TextPart = { path: (string | number)[]; sha256: string; chunks: number; byte_length: number; key?: true };
export type SourceRecordEnvelope = {
  contract: "card-keepr-source-record-envelope@1";
  value: unknown;
  text_parts: TextPart[];
};
export async function retainSourceRecordText(
  db: CatalogueStore,
  set: string,
  input: unknown,
): Promise<SourceRecordEnvelope> {
  const parts: TextPart[] = [];
  let nodes = 0;
  const visit = async (value: unknown, path: (string | number)[]): Promise<unknown> => {
    if (++nodes > 16384 || path.length > 128)
      throw new AdapterParseFailure("Source observation exceeds its structural construction budget.");
    if (typeof value === "string" && value.length > 32768) {
      if (value.length > 16777216 || parts.length === 256)
        throw new AdapterParseFailure("Source observation exceeds its large-field budget.");
      const normalized = value.normalize("NFC");
      const hash = createHash("sha256");
      let bytes = 0;
      for (const chunk of textChunks(normalized)) {
        const encoded = utf8(chunk);
        hash.update(encoded);
        bytes += encoded.length;
      }
      const digest = hash.digest("hex");
      let ordinal = 0,
        pending: SourceAuxiliaryRow[] = [];
      const flush = async () => {
        if (!pending.length) return;
        await db.batch(pending.map((row) => retainSourceAuxiliary(db, set, "text", digest, row)));
        const retained = (
          await sourceAuxiliaryPage(
            db,
            set,
            "text",
            digest,
            pending[0]!.ordinal - 1,
            pending.length,
          ).all<SourceAuxiliaryRow>()
        ).results;
        if (canonicalJson(retained) !== canonicalJson(pending))
          throw new Error("Source text replay changed immutable content.");
        pending = [];
      };
      for (const content of textChunks(normalized)) {
        pending.push({ ordinal: ordinal++, content, sha256: await sha256Text(content) });
        if (pending.length === 4) await flush();
      }
      await flush();
      parts.push({ path, sha256: digest, chunks: ordinal, byte_length: bytes });
      return null;
    }
    if (Array.isArray(value)) {
      const result = [];
      for (let i = 0; i < value.length; i++) result.push(await visit(value[i], [...path, i]));
      return result;
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        let retainedKey = key;
        if (key.length > 32768) {
          retainedKey = `source_key_${parts.length}`;
          while (Object.hasOwn(value, retainedKey) || Object.hasOwn(result, retainedKey)) retainedKey += "_";
        }
        Object.defineProperty(result, retainedKey, {
          value: await visit(entry, [...path, retainedKey]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        if (retainedKey !== key) {
          await visit(key, [...path, retainedKey]);
          parts.at(-1)!.key = true;
        }
      }
      return result;
    }
    return value;
  };
  return { contract: "card-keepr-source-record-envelope@1", value: await visit(input, []), text_parts: parts };
}
function* textChunks(value: string) {
  for (let offset = 0; offset < value.length; ) {
    let end = Math.min(offset + 16384, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    // JSON escaping is lossless for lone UTF-16 surrogates; raw UTF-8 is not.
    yield canonicalJson(value.slice(offset, end));
    offset = end;
  }
}
export async function restoreSourceRecordText(
  db: CatalogueStore,
  set: string,
  envelope: SourceRecordEnvelope,
  read: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation(),
) {
  let value = envelope.value;
  for (const part of envelope.text_parts) {
    let ordinal = 0,
      text = "",
      bytes = 0;
    const hash = createHash("sha256");
    while (ordinal < part.chunks) {
      const rows = (
        await read(() => sourceAuxiliaryPage(db, set, "text", part.sha256, ordinal - 1).all<SourceAuxiliaryRow>())
      ).results;
      if (!rows.length) throw new Error("Source text part is unavailable.");
      for (const row of rows) {
        if (row.ordinal !== ordinal++ || (await sha256Text(row.content)) !== row.sha256)
          throw new Error("Source text part changed.");
        const encoded = utf8(row.content);
        hash.update(encoded);
        bytes += encoded.length;
        const decoded: unknown = JSON.parse(row.content);
        if (typeof decoded !== "string" || bytes > part.byte_length || text.length + decoded.length > 16777216)
          throw new Error("Source text part exceeds its retained bound.");
        text += decoded;
      }
    }
    if (bytes !== part.byte_length || hash.digest("hex") !== part.sha256) throw new Error("Source text root changed.");
    if (!part.path.length) value = text;
    else {
      let target = value as Record<string | number, unknown>;
      for (const key of part.path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
      const key = part.path.at(-1)!;
      if (part.key) {
        const field = target[key];
        delete target[key];
        Object.defineProperty(target, text, { value: field, enumerable: true, writable: true, configurable: true });
      } else Object.defineProperty(target, key, { value: text, enumerable: true, writable: true, configurable: true });
    }
  }
  return value;
}
