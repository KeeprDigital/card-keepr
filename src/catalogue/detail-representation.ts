export type DetailInclude = "printings" | "evidence" | "disagreements";

export function detailIncludeProjection(
  url: URL,
  invalid: (message: string) => Error,
  allowed: readonly DetailInclude[] = ["evidence", "disagreements"],
): ReadonlySet<DetailInclude> {
  const rawValues = url.searchParams.getAll("include");
  const values = rawValues.flatMap((value) =>
    value.split(",").filter((item) => item.length > 0),
  );
  const include = new Set(values);
  if (
    rawValues.length > 1 ||
    include.size !== values.length ||
    [...include].some((value) => !allowed.includes(value as DetailInclude))
  ) {
    throw invalid("Detail include projection is invalid.");
  }
  return include as ReadonlySet<DetailInclude>;
}

export function detailRepresentationKey(
  include: ReadonlySet<DetailInclude>,
): string {
  return [...include].sort().join("+");
}

export function canonicalDetailSelf(
  url: URL,
  include: ReadonlySet<DetailInclude>,
): string {
  const query = new URLSearchParams();
  const values = [...include].sort();
  if (values.length > 0) query.set("include", values.join(","));
  const serialized = query.toString();
  return serialized.length === 0
    ? url.pathname
    : `${url.pathname}?${serialized}`;
}
