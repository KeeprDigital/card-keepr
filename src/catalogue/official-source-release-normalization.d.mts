export type OfficialReleaseDate = {
  precision: "day" | "month" | "quarter" | "year" | "unknown";
  value: string | null;
};

export function normalizedOfficialReleaseDate(
  value: string,
): OfficialReleaseDate;

export function normalizedOfficialReleaseStatus(
  value: string | null,
): "announced" | "released" | null;
