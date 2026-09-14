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
