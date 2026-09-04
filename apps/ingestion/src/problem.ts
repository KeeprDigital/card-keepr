import { problemResponse, typedProblem } from "../../../src/http/problem";

export function ingestionProblemResponse(error: unknown, requestId: string): Response {
  const problem = typedProblem(error);
  if (problem === null)
    return problemResponse({
      requestId,
      status: 500,
      code: "internal_error",
      title: "Internal server error",
      detail: "The administration request could not be completed.",
    });
  const titles: Record<number, string> = {
    404: "Not found",
    409: "Conflict",
    413: "Request too large",
    422: "Invalid request",
  };
  return problemResponse({
    requestId,
    ...problem,
    title: problem.title ?? titles[problem.status] ?? "Administration operation failed",
  });
}
