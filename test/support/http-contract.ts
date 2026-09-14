import { expect } from "vitest";
import * as validators from "./http-response-validators.mjs";

type Document = {
  info: { title: string };
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<
          string,
          { content?: Record<string, unknown>; headers?: Record<string, { required?: boolean; schema?: unknown }> }
        >;
      }
    >
  >;
};
/** Validate actual wire bodies against build-time validators from the generated document. */
export async function assertHttpResponse(
  document: Document,
  path: string,
  method: string,
  response: Response,
  body?: unknown,
) {
  const branch = document.paths[path]?.[method]?.responses[String(response.status)];
  expect(branch, `${method} ${path} status ${response.status} is declared`).toBeDefined();
  for (const [name, header] of Object.entries(branch!.headers ?? {}))
    if (header.required) expect(response.headers.has(name), name).toBe(true);
  if (method === "head" || response.status === 304) {
    expect(response.body).toBeNull();
    return;
  }
  const media = response.headers.get("content-type")?.split(";")[0];
  const representation = branch!.content?.[media!] ?? branch!.content?.["*/*"];
  expect(representation, `declared media ${media}`).toBeDefined();
  // A snapshot retains arbitrary source media, including JSON, as opaque bytes.
  if (!media?.includes("json") || !branch!.content?.[media]) return;
  const worker = document.info.title.includes("administration") ? "admin" : "read";
  const name = validators.responseValidators[`${worker} ${method} ${path} ${response.status} ${media}`];
  const validate = validators[name as keyof typeof validators];
  expect(typeof validate).toBe("function");
  if (typeof validate !== "function") throw new Error("Missing generated response validator.");
  expect(validate(body ?? (await response.clone().json())), `${method} ${path} response matches generated schema`).toBe(
    true,
  );
}
