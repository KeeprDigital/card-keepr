export type LiveLegalityParseOptions = Readonly<{
  unresolvedTargetScope?: boolean;
}>;
export function liveOfficialLegalityDocument(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  sourceLineage: string,
  surface: string,
  requestUrl: string,
  html: string,
  options?: LiveLegalityParseOptions,
): { surface: string; document: Record<string, unknown> } | null;
