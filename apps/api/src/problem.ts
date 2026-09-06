import { logProtectedFailure } from "../../../src/http/protected-failure";
import { problemResponse, typedProblem } from "../../../src/http/problem";

export async function apiProblemResponse(error: unknown, requestId: string): Promise<Response> {
  const problem = typedProblem(error);
  if (problem === null) {
    await logProtectedFailure("api", requestId, error);
    return problemResponse({
      requestId,
      status: 500,
      code: "internal_error",
      title: "Internal server error",
      detail: "The request could not be completed.",
    });
  }
  return problemResponse({ requestId, ...problem, title: problem.title ?? "Request failed" });
}
