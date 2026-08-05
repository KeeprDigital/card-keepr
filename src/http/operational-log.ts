export type OperationalRuntime = "api" | "ingestion";

type D1Metrics = {
  preparedStatements: number;
  batchCalls: number;
  batchStatements: number;
};

export async function withOperationalRequestLog<
  Environment extends { CATALOGUE_DB: D1Database },
>(
  runtime: OperationalRuntime,
  request: Request,
  env: Environment,
  handle: (observedEnv: Environment, requestId: string) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const d1: D1Metrics = {
    preparedStatements: 0,
    batchCalls: 0,
    batchStatements: 0,
  };
  const observedDatabase = observeD1(env.CATALOGUE_DB, d1);
  const observedEnv = new Proxy(env, {
    get(target, property) {
      if (property === "CATALOGUE_DB") return observedDatabase;
      return Reflect.get(target, property, target);
    },
  });
  let response: Response | null = null;
  try {
    response = await handle(observedEnv, requestId);
    return response;
  } finally {
    const status = response?.status ?? 500;
    console.info(JSON.stringify({
      contract: "card-keepr-operational-log@1",
      event: "request.completed",
      runtime,
      request: {
        id: requestId,
        method: request.method,
        route: safeRoute(new URL(request.url).pathname),
      },
      status,
      duration_ms: Math.max(0, Date.now() - startedAt),
      workflow: { step: null },
      retry: {
        count: 0,
        classification: retryClassification(status),
      },
      cache: {
        status: response?.headers.get("cf-cache-status")?.toLowerCase() ??
          "unknown",
      },
      d1: {
        prepared_statements: d1.preparedStatements,
        batch_calls: d1.batchCalls,
        batch_statements: d1.batchStatements,
      },
    }));
  }
}

const staticRouteSegments = new Set([
  "admin", "approval", "backups", "candidate", "cards", "catalogue",
  "catalogue-exports", "catalogue-revisions",
  "catalogue-search-materialization", "collection", "components", "content",
  "curated-revisions", "evidence", "health", "ingestion-runs",
  "legality-status", "observations", "printing-images", "printings",
  "products", "publication-cleanup", "reaffirm", "reconciliation",
  "rejection", "repair", "resume", "retire", "retry",
  "source-observation-sets", "source-snapshots", "status", "supersede",
  "v1", "validate",
]);

function safeRoute(pathname: string): string {
  if (pathname === "/") return pathname;
  return `/${pathname.split("/").filter(Boolean).map((segment) =>
    staticRouteSegments.has(segment) ? segment : ":ref"
  ).join("/")}`;
}

function observeD1(database: D1Database, metrics: D1Metrics): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          metrics.preparedStatements += 1;
          return target.prepare(query);
        };
      }
      if (property === "batch") {
        return <T = unknown>(statements: D1PreparedStatement[]) => {
          metrics.batchCalls += 1;
          metrics.batchStatements += statements.length;
          return target.batch<T>(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function retryClassification(
  status: number,
): "retryable" | "non_retryable" | "not_applicable" {
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return "retryable";
  }
  return status >= 400 ? "non_retryable" : "not_applicable";
}
