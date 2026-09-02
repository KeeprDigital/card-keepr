const monthNumbers = new Map([
  ["january", "01"],
  ["february", "02"],
  ["march", "03"],
  ["april", "04"],
  ["may", "05"],
  ["june", "06"],
  ["july", "07"],
  ["august", "08"],
  ["september", "09"],
  ["october", "10"],
  ["november", "11"],
  ["december", "12"],
]);

const seasonNames = new Map([
  ["spring", "spring"],
  ["summer", "summer"],
  ["autumn", "autumn"],
  ["fall", "autumn"],
  ["winter", "winter"],
]);

export type OfficialReleaseDate = {
  precision: "day" | "month" | "quarter" | "season" | "year" | "unknown";
  value: string | null;
};

// The 2026-08 live Fusion World pages publish season-precision Releases
// ("Winter, 2026") and comma-separated display months ("September, 2025").
// Only the live-shape generations (fusion-world-en@8 and later) opt into
// this vocabulary; earlier registered parser contracts keep failing closed.
export function normalizedOfficialReleaseDate(
  value: string,
  options: { seasons?: boolean } = {},
): OfficialReleaseDate {
  const normalized = value.normalize("NFC").trim();
  if (officialReleaseDateNeedsSchemaReview(normalized)) {
    return { precision: "unknown", value: null };
  }
  if (options.seasons === true) {
    const seasonMatch = normalized.match(/^([A-Za-z]+),?\s+(\d{4})$/u);
    if (seasonMatch !== null) {
      const [, word = "", year = ""] = seasonMatch;
      const season = seasonNames.get(word.toLocaleLowerCase());
      if (season !== undefined) {
        return { precision: "season", value: `${year}-${season}` };
      }
      const commaMonth = monthNumbers.get(word.toLocaleLowerCase());
      if (commaMonth !== undefined) {
        return { precision: "month", value: `${year}-${commaMonth}` };
      }
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    assertCalendarDay(normalized);
    return { precision: "day", value: normalized };
  }
  if (/^\d{4}-\d{2}$/u.test(normalized)) {
    const month = Number.parseInt(normalized.slice(5), 10);
    if (month < 1 || month > 12) {
      throw new Error(`Unrecognized official Release date: ${normalized}.`);
    }
    return { precision: "month", value: normalized };
  }
  const quarter = normalized.match(
    /^(?:Q([1-4])\s+(\d{4})|(\d{4})[\s-]+Q([1-4]))$/iu,
  );
  if (quarter !== null) {
    const year = quarter[2] ?? quarter[3];
    const number = quarter[1] ?? quarter[4];
    return { precision: "quarter", value: `${year}-Q${number}` };
  }
  if (/^\d{4}$/u.test(normalized)) {
    return { precision: "year", value: normalized };
  }
  const monthFirst = normalized.match(
    /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/u,
  );
  const dayFirst = normalized.match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/u,
  );
  const displayMonth = normalized.match(/^([A-Za-z]+)\s+(\d{4})$/u);
  if (monthFirst !== null || dayFirst !== null) {
    const monthName = (monthFirst?.[1] ?? dayFirst?.[2] ?? "")
      .toLocaleLowerCase();
    const month = monthNumbers.get(monthName);
    const day = monthFirst?.[2] ?? dayFirst?.[1] ?? "";
    const year = monthFirst?.[3] ?? dayFirst?.[3] ?? "";
    if (month === undefined) {
      throw new Error(`Unrecognized official Release date: ${normalized}.`);
    }
    const date = `${year}-${month}-${day.padStart(2, "0")}`;
    assertCalendarDay(date);
    return { precision: "day", value: date };
  }
  if (displayMonth !== null) {
    const month = monthNumbers.get((displayMonth[1] ?? "").toLocaleLowerCase());
    if (month !== undefined) {
      return { precision: "month", value: `${displayMonth[2]}-${month}` };
    }
  }
  throw new Error(`Unrecognized official Release date: ${normalized}.`);
}

export function normalizedOfficialReleaseStatus(
  value: string | null,
): "announced" | "released" | null {
  const normalized = value?.normalize("NFC").trim().toLocaleLowerCase() ?? "";
  if (normalized === "") return null;
  if (officialReleaseStatusNeedsSchemaReview(normalized)) {
    return "announced";
  }
  if (
    /^(?:released|on sale|available|available now|now available|sales? start(?:ed)?)$/u
      .test(normalized)
  ) {
    return "released";
  }
  if (
    /^(?:announced|upcoming|coming soon|preorders? open|pre-orders? open|preorder|pre-order)$/u
      .test(normalized)
  ) {
    return "announced";
  }
  throw new Error(`Unrecognized official Release status: ${value}.`);
}

export function officialReleaseDateNeedsSchemaReview(
  value: string | null,
): boolean {
  return unavailableOfficialReleaseVocabulary(value);
}

export function officialReleaseStatusNeedsSchemaReview(
  value: string | null,
): boolean {
  return unavailableOfficialReleaseVocabulary(value);
}

function unavailableOfficialReleaseVocabulary(value: string | null): boolean {
  return value !== null &&
    /^(?:|-|tba|tbd|to be announced|to be determined|unknown|not announced)$/iu
      .test(value.normalize("NFC").trim());
}

function assertCalendarDay(value: string): void {
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Unrecognized official Release date: ${value}.`);
  }
}
