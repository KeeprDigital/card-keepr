import type { PublicBase } from "./public-base";

export type RouteContext<Environment> = {
  request: Request;
  env: Environment;
  requestId: string;
  base: PublicBase;
  context?: ExecutionContext;
};

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
