export function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null || (match[1] === "" && match[2] === "")) {
    return "unsatisfiable";
  }
  if (match[1] === "") {
    const suffix = Number.parseInt(match[2]!, 10);
    if (suffix < 1) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number.parseInt(match[1]!, 10);
  const requestedEnd = match[2] === "" ? size - 1 : Number.parseInt(match[2]!, 10);
  if (offset >= size || requestedEnd < offset) return "unsatisfiable";
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}
