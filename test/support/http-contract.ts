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
  const worker = document.info.title.includes("administration") ? "admin" : "read";
  const key = `${worker} ${method} ${path} ${response.status}`;
  for (const [name, header] of Object.entries(branch!.headers ?? {})) {
    if (header.required) expect(response.headers.has(name), name).toBe(true);
    const value = response.headers.get(name);
    if (value !== null)
      assertGeneratedValue(validators.headerValidators[`${key} ${name}`], value, `${key} header ${name}`);
  }
  if (response.status === 304 || response.status === 204 || !branch!.content) {
    expect(response.body).toBeNull();
    return;
  }
  const media = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const representation = branch!.content?.[media!] ?? branch!.content?.["*/*"];
  expect(representation, `declared media ${media}`).toBeDefined();
  if (method === "head") {
    expect(response.body).toBeNull();
    return;
  }
  // A snapshot retains arbitrary source media, including JSON, as opaque bytes.
  if (!media?.includes("json") || !branch!.content?.[media]) return;
  const name = validators.responseValidators[`${key} ${media}`];
  assertGeneratedValue(name, body ?? (await response.clone().json()), `${key} response`);
}

function assertGeneratedValue(name: string | undefined, value: unknown, description: string) {
  const validate = validators[name as keyof typeof validators];
  expect(typeof validate).toBe("function");
  if (typeof validate !== "function") throw new Error("Missing generated response validator.");
  const matches = validate(value);
  expect(matches, `${description} matches generated schema: ${JSON.stringify(Reflect.get(validate, "errors"))}`).toBe(
    true,
  );
}
