/** Retained Official Source bytes or fields do not satisfy the adapter contract. */
export class AdapterParseFailure extends Error {
  override readonly name = "AdapterParseFailure";
}

/** Keep native decoding failures in the same class without swallowing programming errors. */
export function withAdapterParseFailure<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof URIError) {
      throw new AdapterParseFailure(error.message, { cause: error });
    }
    throw error;
  }
}

export function adapterUrl(value: string | URL, base?: string | URL): URL {
  try {
    return new URL(value, base);
  } catch (error) {
    throw new AdapterParseFailure(error instanceof Error ? error.message : "The Official Source URL is invalid.", {
      cause: error,
    });
  }
}
