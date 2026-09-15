import { AdapterParseFailure, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";
import type { ExtractedSourceRequest, SourceAdapterParseContext } from "./source-adapter-registration-types";
import { tcgdexEnglishSetInventory, tcgdexScopeInventory } from "./tcgdex-scope";

const englishUrl = "https://api.tcgdex.net/v2/en/sets";
const pocketUrl = "https://api.tcgdex.net/v2/en/series/tcgp";
const headers = { accept: "application/json" };

/** The Pocket endpoint is a declared inventory root, not a link claimed to occur in the English body. */
export function tcgdexDiscoveryRequests(
  bytes: Uint8Array,
  context: SourceAdapterParseContext,
): ExtractedSourceRequest[] {
  const parents = context.parents ?? [];
  if (bytes.byteLength > 1024 * 1024) throw new AdapterParseFailure("TCGdex discovery response exceeds 1 MiB.");
  if (context.url === englishUrl) {
    if (parents.length !== 0) throw new AdapterParseFailure("TCGdex English inventory must be a discovery root.");
    tcgdexEnglishSetInventory(bytes);
    return [{ role: "listing", url: pocketUrl, headers }];
  }
  if (context.url === pocketUrl) {
    const english = parents[0];
    if (parents.length !== 1 || !english || english.url !== englishUrl || english.role !== "surface")
      throw new AdapterParseFailure("TCGdex Pocket inventory requires its exact retained English inventory context.");
    const scope = tcgdexScopeInventory(english.bytes, bytes, english.retrievedAt.slice(0, 10));
    return scope.sets.map((set) => ({ role: "listing", url: set.url, headers }));
  }
  if (context.url.startsWith(`${englishUrl}/`)) {
    const [pocket, english] = parents;
    if (
      parents.length !== 2 ||
      !pocket ||
      pocket.url !== pocketUrl ||
      pocket.role !== "listing" ||
      !english ||
      english.url !== englishUrl ||
      english.role !== "surface"
    )
      throw new AdapterParseFailure("TCGdex set detail requires both exact retained inventory ancestors.");
    const scope = tcgdexScopeInventory(english.bytes, pocket.bytes, english.retrievedAt.slice(0, 10));
    const set = scope.qualifySet(bytes, context.url);
    // Classification remains explicit in the set evidence. Collecting a candidate's
    // metadata does not admit its Cards or assert per-record physical issuance.
    return set.cards.map((card) => ({ role: "detail", url: card.url, headers }));
  }
  throw new AdapterParseFailure("TCGdex discovery response is outside the retained inventory graph.");
}

export function qualifiedTcgdexCard(bytes: Uint8Array, context: SourceAdapterParseContext) {
  const [setParent, pocket, english] = context.parents ?? [];
  if (
    bytes.byteLength > 1024 * 1024 ||
    context.parents?.length !== 3 ||
    !setParent ||
    setParent.role !== "listing" ||
    !pocket ||
    pocket.url !== pocketUrl ||
    pocket.role !== "listing" ||
    !english ||
    english.url !== englishUrl ||
    english.role !== "surface"
  )
    throw new AdapterParseFailure("TCGdex Card requires its complete bounded retained set and inventory context.");
  const scope = tcgdexScopeInventory(english.bytes, pocket.bytes, english.retrievedAt.slice(0, 10));
  const { cards, ...set } = scope.qualifySet(setParent.bytes, setParent.url);
  const membership = cards.find((card) => card.url === context.url);
  const value: unknown = withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes)));
  if (
    !membership ||
    !isRecord(value) ||
    value.id !== membership.id ||
    value.localId !== membership.localId ||
    !isRecord(value.set) ||
    value.set.id !== set.id
  )
    throw new AdapterParseFailure("TCGdex Card does not match its exact retained set membership.");
  return { card: value, set, membership };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
