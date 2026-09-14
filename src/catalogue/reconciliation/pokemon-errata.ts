import type { CatalogueCard, CatalogueErratum } from "../shared";
import type { ParsedOfficialErratumObservation } from "./reconciliation-observation";
import { ErratumRulesTextError } from "./errata-rules-text";

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
