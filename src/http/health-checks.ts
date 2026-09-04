// Readiness checks (issue #144). Each check probes one kind of binding with
// a bounded, side-effect-free operation and reports a closed verdict: a
// status plus, on failure, a reason drawn from a fixed vocabulary. Raw
// binding error messages never enter the document; they may carry resource
// names or provider detail that the health route must not leak.

import { inspectWorkflowInstance } from "../catalogue/shared";
import type { PublicBase } from "./public-base";

export type CheckStatus = "pass" | "fail";

export type DatabaseCheck = {
  status: CheckStatus;
  migration_level: number | null;
  current_revision_id: string | null;
  configured_database_id?: string;
  reason?: DatabaseFailure;
};

export type DatabaseFailure =
  | "binding_missing"
  | "query_failed"
  | "schema_state_missing"
  | "catalogue_state_missing"
  | "database_id_not_configured"
  | "timed_out";

export type ProbeFailure = "binding_missing" | "probe_failed" | "timed_out";

export type BucketCheck = { status: CheckStatus; reason?: ProbeFailure };

export type ObjectsCheck = {
  status: CheckStatus;
  buckets: Record<string, BucketCheck>;
};

export type WorkflowBindingFailure = ProbeFailure | "unexpected_instance";

export type WorkflowBindingCheck = {
  status: CheckStatus;
  reason?: WorkflowBindingFailure;
};

export type WorkflowsCheck = {
  status: CheckStatus;
  bindings: Record<string, WorkflowBindingCheck>;
};

export type PublicBaseCheck = {
  status: CheckStatus;
  configured: string;
  arrived_through_public_base: boolean;
};

export type VersionCheck = {
  status: CheckStatus;
  id: string | null;
  tag: string | null;
  timestamp: string | null;
};

export type HealthChecks = {
  database: DatabaseCheck;
  objects: ObjectsCheck;
  workflows?: WorkflowsCheck;
  public_base: PublicBaseCheck;
  version: VersionCheck;
};

export type VersionMetadata = {
  id?: string;
  tag?: string;
  timestamp?: string;
};

/** A Workflow binding as the readiness probe needs it: only `get`. */
export type ProbedWorkflow = {
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
};

export type HealthCheckInput = {
  database: D1Database | undefined;
  /** Present only for the ingestion worker, which configures the id. */
  configuredDatabaseId?: string | undefined;
  buckets: Record<string, R2Bucket | undefined>;
  /** Omitted for a worker without Workflow bindings. */
  workflows?: Record<string, ProbedWorkflow | undefined>;
  publicBase: PublicBase;
  request: Request;
  version: VersionMetadata | undefined;
};

/** The bound each probe gets before it is reported as timed out. */
export const probeTimeoutMilliseconds = 5_000;

/** An id no run ever creates; the Workflow probe asks each binding for it. */
export const workflowProbeInstanceId = "card-keepr-health-probe";

export async function runHealthChecks(
  input: HealthCheckInput,
): Promise<{ status: "ok" | "degraded"; checks: HealthChecks }> {
  const [database, objects, workflows] = await Promise.all([
    checkDatabase(input.database, input.configuredDatabaseId, "configuredDatabaseId" in input),
    checkObjects(input.buckets),
    input.workflows === undefined ? Promise.resolve(undefined) : checkWorkflows(input.workflows),
  ]);
  const checks: HealthChecks = {
    database,
    objects,
    ...(workflows === undefined ? {} : { workflows }),
    public_base: checkPublicBase(input.publicBase, input.request),
    version: checkVersion(input.version),
  };
  const failed = Object.values(checks).some((check) => check.status === "fail");
  return { status: failed ? "degraded" : "ok", checks };
}

export async function checkDatabase(
  database: D1Database | undefined,
  configuredDatabaseId: string | undefined,
  requireConfiguredId: boolean,
): Promise<DatabaseCheck> {
  const identity = requireConfiguredId ? { configured_database_id: configuredDatabaseId ?? "" } : {};
  const failure = (reason: DatabaseFailure): DatabaseCheck => ({
    status: "fail",
    migration_level: null,
    current_revision_id: null,
    ...identity,
    reason,
  });
  if (database === undefined || database === null) {
    return failure("binding_missing");
  }
  // A D1 database id is a UUID; anything else is a missing or mangled var.
  if (
    requireConfiguredId &&
    (typeof configuredDatabaseId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(configuredDatabaseId))
  ) {
    return failure("database_id_not_configured");
  }
  let rows: [{ one: number } | null, { migration_level: number } | null, { current_revision_id: string } | null];
  try {
    rows = await bounded(
      Promise.all([
        database.prepare("SELECT 1 AS one").first<{ one: number }>(),
        database
          .prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1")
          .first<{ migration_level: number }>(),
        database
          .prepare("SELECT current_revision_id FROM catalogue_state WHERE singleton = 1")
          .first<{ current_revision_id: string }>(),
      ]),
    );
  } catch (error) {
    return failure(error instanceof ProbeTimeout ? "timed_out" : "query_failed");
  }
  const [probe, schema, catalogue] = rows;
  if (probe?.one !== 1) return failure("query_failed");
  if (!Number.isInteger(schema?.migration_level)) {
    return failure("schema_state_missing");
  }
  if (typeof catalogue?.current_revision_id !== "string") {
    return failure("catalogue_state_missing");
  }
  return {
    status: "pass",
    migration_level: schema!.migration_level,
    current_revision_id: catalogue!.current_revision_id,
    ...identity,
  };
}

export async function checkObjects(buckets: Record<string, R2Bucket | undefined>): Promise<ObjectsCheck> {
  const entries = await Promise.all(
    Object.entries(buckets).map(async ([name, bucket]) => [name, await probeBucket(bucket)] as const),
  );
  const result = Object.fromEntries(entries);
  return {
    status: entries.some(([, check]) => check.status === "fail") ? "fail" : "pass",
    buckets: result,
  };
}

async function probeBucket(bucket: R2Bucket | undefined): Promise<BucketCheck> {
  if (bucket === undefined || bucket === null) {
    return { status: "fail", reason: "binding_missing" };
  }
  try {
    // A bounded listing needs no sentinel object and proves the bucket is
    // bound and reachable; the result is discarded.
    await bounded(Promise.resolve().then(() => bucket.list({ limit: 1 })));
    return { status: "pass" };
  } catch (error) {
    return {
      status: "fail",
      reason: error instanceof ProbeTimeout ? "timed_out" : "probe_failed",
    };
  }
}

export async function checkWorkflows(workflows: Record<string, ProbedWorkflow | undefined>): Promise<WorkflowsCheck> {
  const entries = await Promise.all(
    Object.entries(workflows).map(async ([name, workflow]) => [name, await probeWorkflow(workflow)] as const),
  );
  return {
    status: entries.some(([, check]) => check.status === "fail") ? "fail" : "pass",
    bindings: Object.fromEntries(entries),
  };
}

// A bound Workflow answers a `get` of an id that was never created with the
// instance-not-found error (or, on runtimes that hand out a lazy handle, a
// status of "unknown"). Anything else is either a binding failure or an
// instance that must not exist.
async function probeWorkflow(workflow: ProbedWorkflow | undefined): Promise<WorkflowBindingCheck> {
  if (workflow === undefined || workflow === null) {
    return { status: "fail", reason: "binding_missing" };
  }
  try {
    const status = await bounded(inspectWorkflowInstance(workflow, workflowProbeInstanceId));
    return status.status === "unknown" ? { status: "pass" } : { status: "fail", reason: "unexpected_instance" };
  } catch (error) {
    if (error instanceof ProbeTimeout) {
      return { status: "fail", reason: "timed_out" };
    }
    return isInstanceNotFound(error) ? { status: "pass" } : { status: "fail", reason: "probe_failed" };
  }
}

function isInstanceNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /instance\.not_found|instance does not exist/iu.test(message);
}

export function checkPublicBase(base: PublicBase, request: Request): PublicBaseCheck {
  const configured = `${base.origin}${base.basePath}`;
  let arrived = false;
  try {
    arrived = new URL(request.url).origin === base.origin;
  } catch {
    arrived = false;
  }
  return {
    status: "pass",
    configured,
    arrived_through_public_base: arrived,
  };
}

export function checkVersion(metadata: VersionMetadata | undefined): VersionCheck {
  return {
    status: "pass",
    id: nonEmpty(metadata?.id),
    tag: nonEmpty(metadata?.tag),
    timestamp: nonEmpty(metadata?.timestamp),
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

class ProbeTimeout extends Error {
  constructor() {
    super("health probe timed out");
    this.name = "ProbeTimeout";
  }
}

function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), probeTimeoutMilliseconds);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
