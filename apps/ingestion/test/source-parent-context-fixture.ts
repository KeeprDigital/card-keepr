import { env } from "cloudflare:workers";
import { catalogueStore, sha256, utf8 } from "../../../src/catalogue/shared";
import { parseSnapshot } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import {
  parentContextRequest,
  parentContextFetch,
  parentContextSnapshot,
  parentContextAttachSnapshot,
} from "./query-helpers/source-parent-context";

export const adapterVersion = "fixture-retained-parent-context@1";

export async function retain(
  run: string,
  sequence: number,
  body: string,
  parent: string | null = null,
  sharedKey?: string,
) {
  const id = `${run}-${sequence}`;
  const url = `https://source.invalid/${sequence}`;
  const at = `2026-09-15T00:0${sequence}:00.000Z`;
  const bytes = utf8(body);
  const objectKey = sharedKey ?? `source-snapshots/${id}`;
  await env.CATALOGUE_DB.batch([
    parentContextRequest(env.CATALOGUE_DB).bind(run, id, sequence, url, parent),
    parentContextFetch(env.CATALOGUE_DB).bind(id, run, id, 1, at, at),
    parentContextSnapshot(env.CATALOGUE_DB).bind(
      id,
      run,
      id,
      id,
      url,
      at,
      await sha256(bytes),
      bytes.length,
      objectKey,
    ),
    parentContextAttachSnapshot(env.CATALOGUE_DB).bind(id, run, id),
  ]);
  await env.EVIDENCE_OBJECTS.put(objectKey, bytes);
  return id;
}

export function parse(id: string) {
  return parseSnapshot(catalogueStore(env.CATALOGUE_DB), env.EVIDENCE_OBJECTS, id, adapterVersion, {
    intent: "collection",
    idempotencyKey: id,
  });
}
