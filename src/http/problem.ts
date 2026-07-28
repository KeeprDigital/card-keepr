type ProblemResponse = {
  requestId: string;
  status: number;
  code: string;
  title: string;
  detail: string;
  headers?: HeadersInit;
};

export function problemResponse(problem: ProblemResponse): Response {
  return Response.json(
    {
      type: `https://card-keepr.invalid/problems/${problem.code}`,
      title: problem.title,
      status: problem.status,
      code: problem.code,
      detail: problem.detail,
      request_id: problem.requestId,
    },
    {
      status: problem.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/problem+json",
        ...problem.headers,
      },
    },
  );
}
