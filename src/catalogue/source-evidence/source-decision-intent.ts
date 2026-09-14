import { canonicalJson } from "../shared";

export function sameSourceDecisionIntent(retainedJson: string, requestedJson: string): boolean {
  if (retainedJson === requestedJson) return true;
  return normalizedGenerationIntent(retainedJson) === normalizedGenerationIntent(requestedJson);
}

function normalizedGenerationIntent(requestJson: string): string {
  const intent: unknown = JSON.parse(requestJson);
  if (
    intent === null ||
    typeof intent !== "object" ||
    !("expected_generation" in intent) ||
    typeof intent.expected_generation !== "string" ||
    !/^\d+$/u.test(intent.expected_generation)
  )
    return requestJson;
  // Accepted decimal generations may have leading zeros. Compare their meaning
  // without changing the retained request bytes or any other decision field.
  return canonicalJson({ ...intent, expected_generation: intent.expected_generation.replace(/^0+(?=\d)/u, "") });
}
