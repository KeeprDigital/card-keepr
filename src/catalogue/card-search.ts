type SearchableCard = Readonly<{
  official_identity: Readonly<{ value: string }>;
  name: string;
  effective_rules_text?: string | null;
}>;

const maximumIndexedTermLength = 128;

export function cardSearchText(card: SearchableCard): string {
  return normalizeSearchText([
    card.official_identity.value,
    card.name,
    card.effective_rules_text ?? "",
  ].join(" "));
}

export function cardSearchTerms(searchText: string): string[] {
  return [
    ...new Set(
      searchText
        .split(" ")
        .filter(
          (term) =>
            term.length > 0 &&
            term.length <= maximumIndexedTermLength,
        ),
    ),
  ];
}

export function cardSearchQuery(
  value: string | null,
): { text: string; anchorTerm: string } | null {
  if (value === null) return null;
  const text = normalizeSearchText(value);
  if (text.length === 0) return null;
  const anchorTerm = cardSearchTerms(text).reduce<string | undefined>(
    (longest, term) =>
      longest === undefined || term.length > longest.length
        ? term
        : longest,
    undefined,
  );
  return anchorTerm === undefined ? null : { text, anchorTerm };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}
