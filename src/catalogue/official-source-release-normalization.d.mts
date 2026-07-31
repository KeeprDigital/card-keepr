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

export function officialReleaseDateNeedsSchemaReview(
  value: string | null,
): boolean;

export function officialReleaseStatusNeedsSchemaReview(
  value: string | null,
): boolean;
