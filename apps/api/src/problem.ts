import { problemResponse, typedProblem } from "../../../src/http/problem";

export function apiProblemResponse(error: unknown, requestId: string): Response {
  const problem = typedProblem(error);
  if (problem === null)
    return problemResponse({
      requestId,
      status: 500,
      code: "internal_error",
      title: "Internal server error",
      detail: "The request could not be completed.",
    });
  return problemResponse({ requestId, ...problem, title: problem.title ?? "Request failed" });
}
