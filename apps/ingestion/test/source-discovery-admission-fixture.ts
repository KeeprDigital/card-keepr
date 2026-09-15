import { canonicalJson, sha256Text } from "../../../src/catalogue/shared";
import expected from "./fixtures/source-discovery-admission.json";
import type { Padding } from "./query-helpers/source-discovery-admission";

export async function paddingChunk(start: number): Promise<Padding[]> {
  const headers = expected.proposals[0]!.headers,
    headers_json = canonicalJson(headers);
  const rows: Padding[] = [];
  for (let index = start; index < start + 64; index++) {
    const uuid = expected.padding_namespace + index.toString(16).padStart(12, "0");
    const url = `https://cards.scryfall.io/normal/front/0/0/${uuid}.jpg?${expected.padding_timestamp}`;
    const digest = await sha256Text(
      canonicalJson({
        source_lineage: "scryfall-magic-en",
        role: "image",
        discovery_key: null,
        method: "GET",
        url,
        headers,
      }),
    );
    rows.push({
      id: `scryfall-magic-en:image:${digest}`,
      url,
      headers_json,
      representation_fingerprint: await sha256Text(canonicalJson({ method: "GET", url, headers })),
      sequence_number: 1000001 + index,
    });
  }
  return rows;
}
