import { problemResponse, typedProblem } from "../../../src/http/problem";
import { publicUrl, type PublicBase } from "../../../src/http/public-base";

export function apiProblemResponse(error: unknown, request: Request, requestId: string, base: PublicBase): Response {
  const problem = typedProblem(error);
  if (problem === null)
    return problemResponse({
      requestId,
      status: 500,
      code: "internal_error",
      title: "Internal server error",
      detail: "The request could not be completed.",
    });
  const path = new URL(request.url).pathname;
  const collection = path.startsWith("/v1/products")
    ? "/v1/products"
    : path.startsWith("/v1/printings")
      ? "/v1/printings"
      : path.startsWith("/v1/catalogue-exports")
        ? "/v1/catalogue-exports"
        : "/v1/cards";
  const title =
    path === "/v1/legality-status"
      ? problem.status === 404
        ? "Not found"
        : problem.status === 422
          ? "Invalid Legality region"
          : problem.status === 500
            ? "Catalogue integrity failure"
            : "Invalid request"
      : problem.status === 409
        ? "Cursor revision unavailable"
        : collection === "/v1/catalogue-exports"
          ? problem.status === 410
            ? "Catalogue Export deleted"
            : problem.code === "invalid_cursor"
              ? "Invalid Catalogue Export cursor"
              : "Invalid Catalogue Export request"
          : collection === "/v1/products"
            ? "Invalid Product request"
            : collection === "/v1/printings"
              ? "Invalid Printing request"
              : "Invalid Card request";
  return problemResponse({
    requestId,
    ...problem,
    title: problem.title ?? title,
    extensions:
      problem.extensions ??
      (problem.code === "cursor_revision_unavailable"
        ? { links: { collection: publicUrl(base, collection) } }
        : problem.invalidParameter == null
          ? undefined
          : { invalid_params: [problem.invalidParameter] }),
  });
}
