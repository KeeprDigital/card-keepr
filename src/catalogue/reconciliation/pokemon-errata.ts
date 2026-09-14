import type { CatalogueCard, CatalogueErratum } from "../shared";
import type { ParsedOfficialErratumObservation } from "./reconciliation-observation";
import { applicableRulesTextErrata, ErratumRulesTextError } from "./errata-rules-text";

/** Publish the same accepted correction in the profile's structured ability facts. */
export function pokemonCorrectedCard(
  card: CatalogueCard,
  errata: readonly CatalogueErratum[],
  observedAt: string,
): CatalogueCard {
  const correction = applicableRulesTextErrata(card, errata, observedAt).at(-1);
  if (correction === undefined) return card;
  const rules = correction.corrected_value;
  const lines = rules?.split("\n").filter((line) => line.startsWith("Sonic Slip: ")) ?? [];
  const corrected = lines[0]?.slice("Sonic Slip: ".length);
  const original = corrected?.replace("attacks from your opponent’s Pokémon done", "attacks done");
  const abilities = card.game_data.attributes.abilities;
  if (
    card.game !== "pokemon" ||
    card.game_data.profile !== "pokemon@1" ||
    card.official_identity.kind !== "card_number" ||
    card.official_identity.value !== "BRILLIANT-STARS-109/172" ||
    !correction.provenance.some((source) => source.source_lineage === "pokemon-official-en") ||
    correction.effective_from !== "2022-02-09" ||
    lines.length !== 1 ||
    corrected === undefined ||
    original === undefined ||
    original === corrected ||
    !correction.official_wording.includes(original) ||
    !correction.official_wording.includes(corrected) ||
    !Array.isArray(abilities)
  )
    throw new ErratumRulesTextError("The Pokémon correction does not establish this Card's structured ability.");
  let matched = 0;
  const updated = abilities.map((ability: unknown) => {
    if (ability === null || typeof ability !== "object" || !("name" in ability) || ability.name !== "Sonic Slip")
      return ability;
    if (!("text" in ability) || (ability.text !== original && ability.text !== corrected))
      throw new ErratumRulesTextError("The Pokémon correction's structured original ability does not match.");
    matched++;
    return { ...ability, text: corrected };
  });
  if (matched !== 1) throw new ErratumRulesTextError("The Pokémon correction's structured ability is ambiguous.");
  return {
    ...card,
    effective_rules_text: rules,
    game_data: { ...card.game_data, attributes: { ...card.game_data.attributes, abilities: updated } },
  };
}

export function pokemonCorrectedRulesText(
  card: CatalogueCard,
  observation: ParsedOfficialErratumObservation,
  prior: readonly CatalogueErratum[],
): string | null {
  const identity = "BRILLIANT-STARS-109/172";
  if (
    card.game !== "pokemon" ||
    card.official_identity.kind !== "card_number" ||
    card.official_identity.value !== identity ||
    observation.target.officialIdentity.kind !== "card_number" ||
    observation.target.officialIdentity.value !== identity ||
    observation.correctedRulesText === null ||
    card.effective_rules_text === null
  )
    throw new ErratumRulesTextError("The Pokémon correction does not identify this exact Card and paragraph.");
  const before = `Sonic Slip: ${observation.observedPrintedRulesText}`;
  const after = `Sonic Slip: ${observation.correctedRulesText}`;
  const lines = card.effective_rules_text.split("\n");
  if (
    !lines.includes(before) &&
    lines.filter((line) => line === after).length === 1 &&
    prior.some(
      (erratum) =>
        erratum.game === card.game &&
        erratum.target_type === "card" &&
        erratum.target_id === card.id &&
        erratum.effective_from === observation.effectiveFrom &&
        erratum.official_wording === observation.officialWording &&
        erratum.corrected_value === card.effective_rules_text &&
        erratum.provenance.some((source) => source.source_lineage === "pokemon-official-en"),
    )
  )
    return card.effective_rules_text;
  if (lines.filter((line) => line === before).length !== 1 || lines.includes(after))
    throw new ErratumRulesTextError("The Pokémon correction's original paragraph is missing or ambiguous.");
  return lines.map((line) => (line === before ? after : line)).join("\n");
}
