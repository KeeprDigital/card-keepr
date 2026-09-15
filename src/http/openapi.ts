import { OpenAPIHono, type RouteConfig, type RouteHandler, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { readBoundedJsonObject } from "./bounded-json";
import { problemResponse } from "./problem";
import type { Route } from "./routes";

export type HttpContext = { request: Request; requestId: string };
export type HttpRoute<C extends object> = Route<C> & {
  definition?: RouteConfig;
  register?: (app: OpenAPIHono<{ Bindings: C }>) => void;
};

/** The registration binds validated inputs and typed JSON responses to the same wire definition. */
export function httpRoute<C extends HttpContext>() {
  return <R extends RouteConfig>(definition: R, handler: RouteHandler<R, { Bindings: C }>): HttpRoute<C> => ({
    method: definition.method.toUpperCase(),
    pathname: definition.path.replaceAll(/\{([^}]+)\}/g, ":$1"),
    definition,
    register: (app) => {
      app.openapi(definition, handler);
    },
    // This route is installed only by the Hono bridge; accidental legacy dispatch fails closed.
    handler: async () => {
      throw new Error("An HTTP contract route requires the Hono router.");
    },
  });
}

/** Retained JSON and binary content stay streamed. Check the declared wire
 * envelope without materializing the body into Hono's JSON response type. */
export function streamingHttpRoute<C extends HttpContext>() {
  return <R extends RouteConfig>(
    definition: R,
    handler: (...args: Parameters<RouteHandler<R, { Bindings: C }>>) => Promise<Response>,
  ): HttpRoute<C> => {
    const checked = async (...args: Parameters<typeof handler>) => {
      const result = await handler(...args);
      const response = args[0].env.request.method === "HEAD" ? new Response(null, result) : result;
      const branch = definition.responses[response.status];
      if (!branch || "$ref" in branch) throw new Error("Retained stream does not match its declared HTTP status.");
      const media = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
      if ("content" in branch && branch.content) {
        if (!media || !(branch.content[media] ?? branch.content["*/*"]))
          throw new Error("Retained stream does not match its declared HTTP media.");
      } else if (response.body !== null) throw new Error("This HTTP response must have no body.");
      for (const [name, header] of Object.entries(branch.headers ?? {})) {
        if ("required" in header && header.required && !response.headers.has(name))
          throw new Error(`Retained stream is missing its declared ${name} header.`);
      }
      return response;
    };
    // Hono assumes application/json is built with c.json. The explicit stream
    // boundary checks the envelope; actual-byte tests verify its schema.
    return httpRoute<C>()(definition, checked as RouteHandler<R, { Bindings: C }>);
  };
}

export function httpRouter<C extends HttpContext>(routes: readonly HttpRoute<C>[]) {
  const app = new OpenAPIHono<{ Bindings: C }>({
    strict: true,
    defaultHook: (result, c) => {
      if (result.success) return;
      return problemResponse({
        requestId: c.env.requestId,
        status: result.target === "json" ? 422 : 400,
        code: "invalid_parameter",
        title: "Invalid request",
        detail: "The request does not match the wire contract.",
        extensions: {
          invalid_params: result.error.issues.flatMap((issue) =>
            issue.code === "unrecognized_keys"
              ? issue.keys.map((name) => ({ name, reason: "This field is not accepted." }))
              : [{ name: issue.path.join(".") || result.target, reason: issue.message }],
          ),
        },
      });
    },
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer" });
  app.onError((error) => {
    if (error instanceof HTTPException && error.status === 400)
      throw Object.assign(new Error("The request body must be valid JSON."), { status: 400, code: "invalid_json" });
    throw error;
  });
  app.notFound((c) =>
    problemResponse({
      requestId: c.env.requestId,
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: "The requested resource does not exist.",
    }),
  );
  // Hono normally routes HEAD through GET. The explicit method gate keeps the
  // existing method surface and lets registered HEAD handlers avoid reading R2 bodies.
  const headPaths = routes
    .filter((route) => route.method === "HEAD")
    .map((route) => new RegExp(`^${route.pathname.replaceAll(/:[A-Za-z]+/g, "[^/]+")}$`));
  app.use("*", async (c, next) => {
    if (c.req.raw.method === "HEAD" && !headPaths.some((path) => path.test(c.req.path))) return c.notFound();
    await next();
  });
  for (const entry of routes) {
    if (entry.register) entry.register(app);
    else app.on(entry.method, entry.pathname, async (c) => (await entry.handler(c.env, c.req.param())) ?? c.notFound());
  }
  return app;
}

export function httpDispatch<C extends HttpContext>(routes: readonly HttpRoute<C>[]) {
  const app = httpRouter(routes);
  return (_method: string, _path: string, context: C) => app.fetch(context.request, context);
}

export const boundedJson: MiddlewareHandler<{ Bindings: HttpContext }> = async (c, next) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return problemResponse({
      requestId: c.env.requestId,
      status: 415,
      code: "unsupported_media_type",
      title: "Unsupported media type",
      detail: "Send application/json.",
    });
  const body = await readBoundedJsonObject(c.req.raw, 16_384, (status, code, detail) =>
    Object.assign(new Error(detail), { status, code }),
  );
  const json = JSON.stringify(body, (_key, value: unknown) => {
    // JSON.parse permits numeric overflow. Reject it before stringify silently
    // changes Infinity to null and a command can retain different owner intent.
    if (typeof value === "number" && !Number.isFinite(value))
      throw Object.assign(new Error("JSON numbers must be finite."), { status: 422, code: "invalid_parameter" });
    return value;
  });
  c.req.raw = new Request(c.req.raw, { method: c.req.raw.method, body: json });
  await next();
};

export const identifier = z.string().min(1);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const problemSchema = z
  .strictObject({
    type: z.string(),
    title: identifier,
    status: z.number().int().min(400).max(599),
    code: identifier,
    detail: identifier,
    request_id: identifier,
    invalid_params: z.array(z.strictObject({ name: z.string(), reason: identifier })).optional(),
    links: z.record(z.string(), z.string()).optional(),
  })
  .openapi("Problem");
export const problemResponses = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503].map((status) => [
    status,
    {
      description: "Request, authorization, domain conflict or service failure. See code and detail.",
      headers: {
        "Cache-Control": { schema: { type: "string" as const } },
        "Retry-After": { schema: { type: "string" as const } },
        "WWW-Authenticate": { schema: { type: "string" as const } },
      },
      content: { "application/problem+json": { schema: problemSchema } },
    },
  ]),
);
export const secured = [{ bearerAuth: [] }];
export const revisionResponseHeaders = {
  ETag: { required: true, schema: { type: "string" as const } },
  "X-Catalogue-Revision": { required: true, schema: { type: "string" as const } },
  "Cache-Control": { required: true, schema: { type: "string" as const } },
};

/** Validate retained JSON without rebuilding it or stripping literal property names. */
export function retainedWireValue<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  schema.parse(value);
  return value as z.infer<T>;
}
