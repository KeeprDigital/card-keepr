export async function readBoundedJsonObject(
  request: Request,
  maximumBytes: number,
  problem: (status: number, code: string, detail: string) => Error,
): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number.parseInt(declaredLength, 10) > maximumBytes) {
    throw problem(413, "request_too_large", `The request body exceeds ${maximumBytes / 1024} KiB.`);
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  if (reader !== undefined) {
    for (;;) {
      const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw problem(413, "request_too_large", `The request body exceeds ${maximumBytes / 1024} KiB.`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw problem(400, "invalid_json", "The request body must be a JSON object.");
  }
}
