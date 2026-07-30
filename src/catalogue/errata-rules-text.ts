import type {
  FixtureCard,
  SupportedGame,
} from "./fixture";
import { canonicalJson, sha256Text } from "./serialization";

export type CatalogueErratum = Readonly<{
  id: string;
  game: SupportedGame;
  target_type: "card" | "printing";
  target_id: string;
  effective_from: string | null;
  official_wording: string;
  corrected_value: string | null;
  provenance: readonly Readonly<{
    source_lineage: string;
    source_observation_id: string;
  }>[];
}>;

export type ParsedRulesTextErratum = Readonly<{
  targetType: "card" | "printing";
  effectiveFrom: string | null;
  officialWording: string;
  correctedValue: string | null;
}>;

export function parseRulesTextErrata(
  value: unknown,
): readonly ParsedRulesTextErratum[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ErratumRulesTextError(
      "Errata evidence must be an array.",
    );
  }
  return value.map((item) => {
    const erratum = requiredRecord(item, "Erratum");
    if (erratum.authority !== "official_errata") {
      throw new ErratumRulesTextError(
        "Rules Text changes require the field-specific official Errata authority.",
      );
    }
    if (erratum.field !== "effective_rules_text") {
      throw new ErratumRulesTextError(
        "An Erratum must name the exact Effective Rules Text field it corrects.",
      );
    }
    if (
      erratum.target_type !== "card" &&
      erratum.target_type !== "printing"
    ) {
      throw new ErratumRulesTextError(
        "An Erratum target must be the accepted Card or its narrower Printing.",
      );
    }
    const effectiveFrom = nullableDate(
      erratum.effective_from,
      "Erratum effective_from",
    );
    const officialWording = requiredString(
      erratum.official_wording,
      "Erratum official_wording",
    );
    if (
      erratum.corrected_value !== null &&
      (typeof erratum.corrected_value !== "string" ||
        erratum.corrected_value.length === 0)
    ) {
      throw new ErratumRulesTextError(
        "New Erratum wording cannot be represented without invented precision.",
      );
    }
    return {
      targetType: erratum.target_type,
      effectiveFrom,
      officialWording,
      correctedValue: erratum.corrected_value,
    };
  });
}

export async function identifyRulesTextErrata(input: {
  game: SupportedGame;
  cardId: string;
  printingId: string | null;
  sourceLineage: string;
  sourceObservationId: string;
  errata: readonly ParsedRulesTextErratum[];
}): Promise<readonly CatalogueErratum[]> {
  return Promise.all(
    input.errata.map(async (erratum) => {
      if (erratum.targetType === "printing" && input.printingId === null) {
        throw new ErratumRulesTextError(
          "A Printing-scoped Erratum requires an accepted Printing target.",
        );
      }
      const targetId =
        erratum.targetType === "card"
          ? input.cardId
          : input.printingId!;
      const semantics = {
        game: input.game,
        target_type: erratum.targetType,
        target_id: targetId,
        effective_from: erratum.effectiveFrom,
        official_wording: erratum.officialWording,
        corrected_value: erratum.correctedValue,
      };
      return {
        id: `erratum_${(await sha256Text(canonicalJson(semantics))).slice(0, 32)}`,
        ...semantics,
        provenance: [
          {
            source_lineage: input.sourceLineage,
            source_observation_id: input.sourceObservationId,
          },
        ],
      };
    }),
  );
}

export function mergeCatalogueErrata(
  carried: readonly CatalogueErratum[],
  observed: readonly CatalogueErratum[],
): CatalogueErratum[] {
  const merged = new Map<string, CatalogueErratum>();
  for (const erratum of [...carried, ...observed]) {
    const existing = merged.get(erratum.id);
    if (
      existing !== undefined &&
      canonicalErratum(existing) !== canonicalErratum(erratum)
    ) {
      throw new ErratumRulesTextError(
        "An immutable Erratum identity was observed with changed wording.",
      );
    }
    merged.set(erratum.id, {
      ...erratum,
      provenance: uniqueProvenance([
        ...(existing?.provenance ?? []),
        ...erratum.provenance,
      ]),
    });
  }
  return [...merged.values()].sort((left, right) =>
    canonicalJson([
      left.effective_from ?? "",
      left.target_type,
      left.target_id,
      left.id,
    ]).localeCompare(
      canonicalJson([
        right.effective_from ?? "",
        right.target_type,
        right.target_id,
        right.id,
      ]),
    ),
  );
}

export function deriveEffectiveRulesText(
  card: FixtureCard,
  errata: readonly CatalogueErratum[],
  observedAt: string,
): string | null {
  const applicable = errata
    .filter(
      (erratum) =>
        erratum.game === card.game &&
        erratum.target_type === "card" &&
        erratum.target_id === card.id &&
        (erratum.effective_from === null ||
          erratum.effective_from <= observedAt.slice(0, 10)),
    )
    .sort((left, right) =>
      canonicalJson([left.effective_from ?? "", left.id]).localeCompare(
        canonicalJson([right.effective_from ?? "", right.id]),
      ),
    );
  const latest = applicable.at(-1);
  if (latest === undefined) return card.effective_rules_text;
  const competingValues = new Set(
    applicable
      .filter(
        (erratum) => erratum.effective_from === latest.effective_from,
      )
      .map((erratum) => canonicalJson(erratum.corrected_value)),
  );
  if (competingValues.size > 1) {
    throw new ErratumRulesTextError(
      "The Card has conflicting applicable Errata for Effective Rules Text at the same effective date.",
    );
  }
  return latest.corrected_value;
}

export function exportErratum(erratum: CatalogueErratum) {
  return {
    type: "erratum" as const,
    id: erratum.id,
    game: erratum.game,
    target_type: erratum.target_type,
    target_id: erratum.target_id,
    effective_from: erratum.effective_from,
    official_wording: erratum.official_wording,
    corrected_value: erratum.corrected_value,
  };
}

export function canonicalErratum(erratum: CatalogueErratum): string {
  return canonicalJson(exportErratum(erratum));
}

export function erratumTargetLifecycleKey(
  erratumId: string,
  sourceLineage: string,
): string {
  return canonicalJson([erratumId, sourceLineage]);
}

export class ErratumRulesTextError extends Error {}

function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ErratumRulesTextError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ErratumRulesTextError(`${field} must be a non-empty string.`);
  }
  return value;
}

function nullableDate(value: unknown, field: string): string | null {
  if (value === null) return null;
  const instant =
    typeof value === "string"
      ? new Date(`${value}T00:00:00.000Z`)
      : null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    instant === null ||
    Number.isNaN(instant.valueOf()) ||
    instant.toISOString().slice(0, 10) !== value
  ) {
    throw new ErratumRulesTextError(
      `${field} must be a calendar date or null.`,
    );
  }
  return value;
}

function uniqueProvenance(
  provenance: CatalogueErratum["provenance"],
): CatalogueErratum["provenance"] {
  return [
    ...new Map(
      provenance.map((item) => [
        canonicalJson([
          item.source_lineage,
          item.source_observation_id,
        ]),
        item,
      ]),
    ).values(),
  ].sort((left, right) =>
    canonicalJson([
      left.source_lineage,
      left.source_observation_id,
    ]).localeCompare(
      canonicalJson([
        right.source_lineage,
        right.source_observation_id,
      ]),
    ),
  );
}
