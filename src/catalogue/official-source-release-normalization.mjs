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

export function normalizedOfficialReleaseDate(value) {
  const normalized = value.normalize("NFC").trim();
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
    const monthName = (monthFirst?.[1] ?? dayFirst?.[2]).toLocaleLowerCase();
    const month = monthNumbers.get(monthName);
    const day = monthFirst?.[2] ?? dayFirst?.[1];
    const year = monthFirst?.[3] ?? dayFirst?.[3];
    if (month === undefined) {
      throw new Error(`Unrecognized official Release date: ${normalized}.`);
    }
    const date = `${year}-${month}-${day.padStart(2, "0")}`;
    assertCalendarDay(date);
    return { precision: "day", value: date };
  }
  if (displayMonth !== null) {
    const month = monthNumbers.get(displayMonth[1].toLocaleLowerCase());
    if (month !== undefined) {
      return { precision: "month", value: `${displayMonth[2]}-${month}` };
    }
  }
  throw new Error(`Unrecognized official Release date: ${normalized}.`);
}

export function normalizedOfficialReleaseStatus(value) {
  const normalized = value?.normalize("NFC").trim().toLocaleLowerCase() ?? "";
  if (normalized === "" || normalized === "-") return null;
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

function assertCalendarDay(value) {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Unrecognized official Release date: ${value}.`);
  }
}
