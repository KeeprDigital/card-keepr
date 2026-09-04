/** Identifies source-contract failures separately from invalid adapter configuration. */
export class AdapterParseFailure extends Error {
  override readonly name = "AdapterParseFailure";
  readonly category: "source-contract" | "configuration";

  constructor(message: string, options?: ErrorOptions & { category?: "source-contract" | "configuration" }) {
    super(message, options);
    this.category = options?.category ?? "source-contract";
  }
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
