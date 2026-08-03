export function liveOfficialLegalityDocument(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  sourceLineage: string,
  surface: string,
  requestUrl: string,
  html: string,
): { surface: string; document: Record<string, unknown> } | null;
