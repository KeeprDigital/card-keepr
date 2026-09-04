export function ifNoneMatchMatches(
  request: Request,
  currentEtag: string,
): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) return false;
  const currentOpaqueTag = weakOpaqueTag(currentEtag);
  if (currentOpaqueTag === null) {
    throw new Error("The current ETag is invalid.");
  }
  const entityTags = parseEntityTagList(header);
  return (
    entityTags === "*" ||
    entityTags?.some((entityTag) => entityTag === currentOpaqueTag) === true
  );
}

function parseEntityTagList(value: string): "*" | string[] | null {
  let offset = 0;
  const tags: string[] = [];
  while (offset < value.length) {
    while (value[offset] === " " || value[offset] === "\t") offset += 1;
    if (value[offset] === "*") {
      offset += 1;
      while (value[offset] === " " || value[offset] === "\t") offset += 1;
      return offset === value.length ? "*" : null;
    }
    const weak = value.slice(offset, offset + 2) === "W/";
    if (weak) offset += 2;
    if (value[offset] !== '"') return null;
    const start = offset;
    offset += 1;
    while (offset < value.length && value[offset] !== '"') {
      const code = value.charCodeAt(offset);
      if (
        code === 0x21 ||
        (code >= 0x23 && code <= 0x7e) ||
        code >= 0x80
      ) {
        offset += 1;
        continue;
      }
      return null;
    }
    if (value[offset] !== '"') return null;
    offset += 1;
    tags.push(value.slice(start, offset));
    while (value[offset] === " " || value[offset] === "\t") offset += 1;
    if (offset === value.length) return tags;
    if (value[offset] !== ",") return null;
    offset += 1;
  }
  return null;
}

function weakOpaqueTag(value: string): string | null {
  const tag = value.startsWith("W/") ? value.slice(2) : value;
  const parsed = parseEntityTagList(tag);
  return Array.isArray(parsed) && parsed.length === 1 ? parsed[0]! : null;
}
