import type { PublicBase } from "./public-base";

export type RouteContext<Environment> = {
  request: Request;
  env: Environment;
  requestId: string;
  base: PublicBase;
  context?: ExecutionContext;
};

export type Route<Context> = {
  method: string;
  pathname: string;
  handler: (context: Context, params: Record<string, string | undefined>) => Promise<Response | null>;
};

export function route<Context>(method: string, pathname: string, handler: Route<Context>["handler"]): Route<Context> {
  return { method, pathname, handler };
}

export function routeTable<Context>(routes: readonly Route<Context>[]) {
  const entries = routes.map((entry) => ({ ...entry, pattern: new URLPattern({ pathname: entry.pathname }) }));
  return async (method: string, pathname: string, context: Context): Promise<Response | null> => {
    for (const entry of entries) {
      if (entry.method !== method) continue;
      const match = entry.pattern.exec({ pathname });
      if (match === null) continue;
      const params = Object.fromEntries(
        Object.entries(match.pathname.groups).map(([key, value]) => [
          key,
          value === undefined ? undefined : decodeURIComponent(value),
        ]),
      );
      return entry.handler(context, params);
    }
    return null;
  };
}

export function routeSegments(
  routes: readonly { pathname: string }[],
  preRoutePaths: readonly string[] = [],
): ReadonlySet<string> {
  return new Set(
    [...routes.map((route) => route.pathname), ...preRoutePaths]
      .flatMap((pathname) => pathname.split("/"))
      .filter((segment) => /^[a-zA-Z0-9-]+$/.test(segment)),
  );
}
