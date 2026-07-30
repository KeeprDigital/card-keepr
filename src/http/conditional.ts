export function ifNoneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) return false;
  const comparable = etag.replace(/^W\//u, "");
  return header
    .split(",")
    .map((value) => value.trim())
    .some(
      (value) =>
        value === "*" || value.replace(/^W\//u, "") === comparable,
    );
}
