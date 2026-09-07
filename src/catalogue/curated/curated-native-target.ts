import { AdministrationProblem, type CatalogueStore, sha256Text } from "../shared";
import * as repository from "./curated-native-target-repository";

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
  kind: "card" | "printing",
  id: string,
): Promise<Value | undefined> {
  const published = await repository
    .curatedNativeRevisionStatement(db, revision)
    .first<{ publication_operation_id: string | null; query_state: string | null }>();
  if (!published?.publication_operation_id) return undefined;
  if (published.query_state !== "available") throw unavailable();
  const collection = kind === "card" ? "cards" : "printings";
  const member = await repository
    .curatedNativeMemberStatement(db, revision, collection, id)
    .first<{ preparation_id: string; supported_game: string; card_id: string | null }>();
  if (!member) throw missing();
  if (member.supported_game !== game)
    throw new AdministrationProblem(
      422,
      "curated_revision_target_invalid",
      "The target does not belong to the proposed Supported Game.",
    );
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
    if (kind === "card" && entity.game !== game) throw unavailable();
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
