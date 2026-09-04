type ProblemResponse = {
  requestId: string;
  status: number;
  code: string;
  title: string;
  detail: string;
  headers?: HeadersInit;
  extensions?: Record<string, unknown>;
};

export function problemResponse(problem: ProblemResponse): Response {
  const headers = new Headers(problem.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/problem+json");
  return Response.json(
    {
      type: `https://card-keepr.invalid/problems/${problem.code}`,
      title: problem.title,
      status: problem.status,
      code: problem.code,
      detail: problem.detail,
      request_id: problem.requestId,
      ...problem.extensions,
    },
    {
      status: problem.status,
      headers,
    },
  );
}

/** The worker boundary accepts domain problems by contract, without importing their classes. */
export function typedProblem(
  error: unknown,
): (Omit<ProblemResponse, "requestId" | "title"> & { title?: string; invalidParameter?: unknown }) | null {
  if (error === null || typeof error !== "object") return null;
  const problem = error as Record<string, unknown>;
  const detail = typeof problem.detail === "string" ? problem.detail : problem.message;
  if (
    typeof problem.status !== "number" ||
    !Number.isInteger(problem.status) ||
    problem.status < 400 ||
    problem.status > 599 ||
    typeof problem.code !== "string" ||
    typeof detail !== "string"
  )
    return null;
  return {
    status: problem.status,
    code: problem.code,
    detail,
    ...(typeof problem.title === "string" ? { title: problem.title } : {}),
    ...(problem.headers === undefined ? {} : { headers: problem.headers as HeadersInit }),
    ...(problem.extensions === undefined ? {} : { extensions: problem.extensions as Record<string, unknown> }),
    invalidParameter: problem.invalidParameter,
  };
}
