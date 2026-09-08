import { AdministrationProblem, type CatalogueStore, sha256Text } from "../shared";
import * as repository from "./curated-native-target-repository";

type EntityKind =
  | "card"
  | "printing"
  | "product"
  | "distribution_context"
  | "erratum"
  | "release"
  | "product_relationship";
const collections = {
  card: "cards",
  printing: "printings",
  product: "products",
  distribution_context: "distribution_contexts",
  erratum: "errata",
  release: "releases",
  product_relationship: "product_relationships",
} as const;
type Value = Record<string, unknown>;
type Row = { content: string; sha256: string };
type Positions = Record<string, number>;
const unavailable = () =>
  new AdministrationProblem(
    503,
    "curated_revision_target_unavailable",
    "The retained published target could not be verified.",
  );
const missing = () =>
  new AdministrationProblem(
    422,
    "curated_revision_target_not_found",
    "The target entity does not exist in the expected Catalogue Revision.",
  );
async function verified(row: Row | null): Promise<Value> {
  if (
    !row ||
    new TextEncoder().encode(row.content).byteLength > 524288 ||
    (await sha256Text(row.content)) !== row.sha256
  )
    throw unavailable();
  return JSON.parse(row.content) as Value;
}

/** Undefined selects the legacy reader; native publications never fall back to legacy rows. */
export async function nativeCuratedTarget(
  db: CatalogueStore,
  revision: string,
  game: string,
  kind: EntityKind,
  id: string,
): Promise<Value | undefined> {
  const published = await repository
    .curatedNativeRevisionStatement(db, revision)
    .first<{ publication_operation_id: string | null; query_state: string | null }>();
  if (!published?.publication_operation_id) return undefined;
  if (published.query_state !== "available") throw unavailable();
  const collection = collections[kind];
  const member = await repository
    .curatedNativeMemberStatement(db, revision, collection, id)
    .first<{ preparation_id: string; supported_game: string; card_id: string | null; product_id: string | null }>();
  if (!member) throw missing();
  if (member.supported_game !== game)
    throw new AdministrationProblem(
      422,
      "curated_revision_target_invalid",
      "The target does not belong to the proposed Supported Game.",
    );
  if (kind === "release") {
    if (!member.product_id) throw unavailable();
    const product = await nativeCuratedTarget(db, revision, game, "product", member.product_id);
    const release = (product?.releases as Value[] | undefined)?.find((value) => value.id === id);
    if (!release) throw unavailable();
    return release;
  }
  const preparation = member.preparation_id;
  const curated = await verified(
    await repository.curatedNativeCheckpointStatement(db, preparation, "curated_revisions").first<Row>(),
  );
  if ((curated.progress as Value)?.stage !== "complete") throw unavailable();
  const correctionRow = await repository
    .curatedNativeCheckpointStatement(db, preparation, "identity_application")
    .first<Row>();
  const pin = await repository
    .curatedNativeCorrectionPinStatement(db, preparation)
    .first<{ decision_cutoff: number; games_json: string }>();
  if (
    !pin ||
    !Number.isSafeInteger(pin.decision_cutoff) ||
    pin.decision_cutoff < 0 ||
    !JSON.parse(pin.games_json).includes(game) ||
    (pin.decision_cutoff > 0 && !correctionRow)
  )
    throw unavailable();
  const correction = correctionRow ? await verified(correctionRow) : null;
  if (correction && correction.stage !== "complete") throw unavailable();
  const layers: [string, Positions | undefined][] = [
    ["corrections", correction?.positions as Positions | undefined],
    ["curated", curated.curated as Positions],
    ["before_curated", curated.official as Positions],
  ];
  if (["products", "distribution_contexts", "product_relationships"].includes(collection)) {
    const official = await verified(
      await repository.curatedNativeCheckpointStatement(db, preparation, "official_errata").first<Row>(),
    );
    const productGames = official.productGames;
    if (
      official.errataComplete !== true ||
      !Array.isArray(productGames) ||
      productGames.length > 5 ||
      new Set(productGames).size !== productGames.length ||
      productGames.some((value) => !["one-piece", "digimon", "fusion-world", "gundam", "riftbound"].includes(value))
    )
      throw unavailable();
    // Each game's reduction inherits the preceding draft, including its contexts and relationships.
    for (const productGame of [...productGames].reverse()) {
      const product = await verified(
        await repository
          .curatedNativeCheckpointStatement(db, preparation, `product_reduction:${productGame}`)
          .first<Row>(),
      );
      if (product.stage !== "complete") throw unavailable();
      layers.push([`product_result_${productGame}`, product.result as Positions]);
    }
    layers.push(["prior_products", (official.prior as Value)?.priorProducts as Positions]);
  }
  const key = await sha256Text(id);
  for (const [phase, positions] of layers) {
    const through = positions?.[collection] ?? 0;
    if (!Number.isSafeInteger(through) || through < 0) throw unavailable();
    if (!through) continue;
    const row = await repository
      .curatedNativeEntityStatement(db, preparation, `candidate_${phase}_${collection}`, key, through)
      .first<Row>();
    if (!row) continue;
    const envelope = await verified(row);
    const parts = envelope.text_parts as {
      path: (string | number)[];
      sha256: string;
      chunks: number;
      byte_length: number;
    }[];
    if (envelope.contract !== "card-keepr-partitioned-record@1" || !Array.isArray(parts)) throw unavailable();
    let bytes = new TextEncoder().encode(row.content).byteLength;
    for (const part of parts) {
      bytes += part.byte_length;
      if (
        !Number.isSafeInteger(part.byte_length) ||
        part.byte_length < 0 ||
        !Number.isSafeInteger(part.chunks) ||
        part.chunks < 1 ||
        part.chunks > 128 ||
        bytes > 4_000_000
      )
        throw unavailable();
      let text = "";
      for (let ordinal = 0; ordinal < part.chunks; ordinal++) {
        const chunk = await repository
          .curatedNativeTextStatement(db, preparation, part.sha256, ordinal)
          .first<{ content: string }>();
        if (
          !chunk ||
          new TextEncoder().encode(text).byteLength + new TextEncoder().encode(chunk.content).byteLength >
            part.byte_length
        )
          throw unavailable();
        text += chunk.content;
      }
      if (new TextEncoder().encode(text).byteLength !== part.byte_length || (await sha256Text(text)) !== part.sha256)
        throw unavailable();
      let target = envelope.value as Value;
      for (const segment of part.path.slice(0, -1)) {
        if (!target || !Object.hasOwn(target, segment)) throw unavailable();
        target = target[segment] as Value;
      }
      const last = part.path.at(-1);
      if (last === undefined || !target || !Object.hasOwn(target, last)) throw unavailable();
      target[last] = text;
    }
    const retained = envelope.value as Value;
    const entity = retained?.entity as Value | null;
    if (retained?.id !== id || !entity || entity.id !== id) throw unavailable();
    if (kind !== "printing" && entity.game !== game) throw unavailable();
    if (kind === "printing") {
      if (entity.card_id !== member.card_id || typeof entity.card_id !== "string") throw unavailable();
      const owner = await repository
        .curatedNativeMemberStatement(db, revision, "cards", entity.card_id)
        .first<{ supported_game: string; preparation_id: string }>();
      if (!owner || owner.supported_game !== game || owner.preparation_id !== preparation) throw unavailable();
    }
    return entity;
  }
  throw unavailable();
}

/** Only the exact endpoints and matching relationship records enter this small candidate. */
export async function nativeCuratedRelationshipTarget(
  db: CatalogueStore,
  revision: string,
  game: string,
  target: { relationship_kind: string; from: { type: string; id: string }; to: { type: string; id: string } },
): Promise<Value | undefined> {
  const published = await repository
    .curatedNativeRevisionStatement(db, revision)
    .first<{ publication_operation_id: string | null; query_state: string | null }>();
  if (!published?.publication_operation_id) return undefined;
  if (published.query_state !== "available") throw unavailable();
  const candidate: Record<string, Value[]> = {
    cards: [],
    printings: [],
    products: [],
    distribution_contexts: [],
    product_relationships: [],
  };
  let bytes = 0;
  const add = (collection: string, entity: Value) => {
    bytes += new TextEncoder().encode(JSON.stringify(entity)).byteLength;
    if (bytes > 4_000_000) throw unavailable();
    if (!candidate[collection]!.some((value) => value.id === entity.id)) candidate[collection]!.push(entity);
  };
  for (const endpoint of [target.from, target.to]) {
    if (!["card", "printing", "product", "distribution_context"].includes(endpoint.type)) throw missing();
    const kind = endpoint.type as EntityKind;
    const entity = await nativeCuratedTarget(db, revision, game, kind, endpoint.id);
    if (!entity) throw unavailable();
    add(collections[kind], entity);
    if (kind === "printing") {
      const card = await nativeCuratedTarget(db, revision, game, "card", entity.card_id as string);
      if (!card) throw unavailable();
      add("cards", card);
    }
  }
  let after = "";
  let count = 0;
  for (;;) {
    const page = await repository
      .curatedNativeRelationshipsStatement(db, revision, game, target, after)
      .all<{ entity_id: string }>();
    for (const row of page.results) {
      if (++count > 64) throw unavailable();
      const entity = await nativeCuratedTarget(db, revision, game, "product_relationship", row.entity_id);
      if (
        !entity ||
        entity.kind !== target.relationship_kind ||
        (entity.from as Value)?.type !== target.from.type ||
        (entity.from as Value)?.id !== target.from.id ||
        (entity.to as Value)?.type !== target.to.type ||
        (entity.to as Value)?.id !== target.to.id
      )
        throw unavailable();
      add("product_relationships", entity);
      after = row.entity_id;
    }
    if (page.results.length < 16) break;
  }
  return candidate;
}
