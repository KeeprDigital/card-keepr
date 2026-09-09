import { ObjectMemberParseFailure, resumableObjectMembers } from "../shared";
import { AdapterParseFailure } from "./adapter-parse-failure";

export async function* adapterObjectMembers(
  source: () => AsyncIterable<string>,
  limits: Parameters<typeof resumableObjectMembers>[2],
) {
  try {
    yield* resumableObjectMembers(source, null, limits);
  } catch (error) {
    if (error instanceof ObjectMemberParseFailure || error instanceof SyntaxError)
      throw new AdapterParseFailure(error.message, { cause: error });
    throw error;
  }
}
