import { canonicalJson, exportedGameProfileSchema, sha256Text } from "../shared";

export type PublicationEnvelope = {
  value: Record<string, unknown>;
  text_parts: { path: (string | number)[]; sha256: string; chunks: number; byte_length: number }[];
};

/** Derive at most one public record from one bounded, digest-verified candidate envelope. */
export async function publicationRecord(kind: string, envelope: PublicationEnvelope, subrecord: number) {
  if (kind === "selected_games") {
    const game = String(envelope.value);
    const names: Record<string, string> = {
      "one-piece": "One Piece Card Game",
      "fusion-world": "Dragon Ball Super Card Game Fusion World",
      digimon: "Digimon Card Game",
      gundam: "Gundam Card Game",
    };
    return {
      kind: subrecord === 0 ? "supported_games" : "game_profiles",
      envelope: {
        value:
          subrecord === 0
            ? {
                id: `game_${game.replaceAll("-", "_")}`,
                key: game,
                name: names[game],
                supported_locales: game === "gundam" ? ["EN-ASIA", "EN-US"] : ["EN-OCEANIA"],
                game_profile: `${game}@1`,
              }
            : { id: `${game}@1`, profile: `${game}@1`, game, schema: exportedGameProfileSchema(`${game}@1`) },
        text_parts: [],
      } as PublicationEnvelope,
      more: subrecord === 0,
    };
  }
  if (kind === "products") {
    const releases = envelope.value.releases as Record<string, unknown>[];
    if (subrecord > 0)
      return {
        kind: "releases",
        envelope: {
          value: releases[subrecord - 1]!,
          text_parts: envelope.text_parts
            .filter((p) => p.path[0] === "releases" && p.path[1] === subrecord - 1)
            .map((p) => ({ ...p, path: p.path.slice(2) })),
        },
        more: subrecord < releases.length,
      };
    return { kind, envelope, more: releases.length > 0 };
  }
  if (kind === "errata") {
    const observations = new Map<string, string[]>();
    for (const p of envelope.value.provenance as { source_lineage: string; source_observation_id: string }[]) {
      const ids = observations.get(p.source_lineage) ?? [];
      ids.push(p.source_observation_id);
      observations.set(p.source_lineage, ids);
    }
    const lineages = [...observations.keys()].sort();
    if (subrecord > 0) {
      const source = lineages[subrecord - 1]!;
      const e = envelope.value;
      const id = `relationship_${await sha256Text(canonicalJson({ kind: "erratum-target", erratum_id: e.id, target_type: e.target_type, target_id: e.target_id, source_lineage: source }))}`;
      return {
        kind: "relationships",
        envelope: {
          value: {
            id,
            game: e.game,
            kind: "erratum-target",
            from: { type: "erratum", id: e.id },
            to: { type: e.target_type, id: e.target_id },
            source_observation_ids: observations.get(source)!.sort(),
            relationship_value: "effective_rules_text",
            observed: true,
          },
          text_parts: [],
        },
        more: subrecord < lineages.length,
      };
    }
    return { kind, envelope, more: lineages.length > 0 };
  }
  return { kind, envelope, more: false };
}
