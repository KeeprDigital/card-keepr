type NumericObservation = { observations: number; total: number };
type Outcome = { attempted: number; fulfilled: number; rejected: number };
export type BindingObservation = {
  calls: number;
  methods: Record<string, number>;
  outcomes: Record<string, Outcome>;
  returned_d1_metadata: Record<string, NumericObservation>;
  returned_r2_metadata: Record<string, NumericObservation>;
  d1_batch_statements: number;
  driver_events: Record<string, number>;
};
const empty = (): BindingObservation => ({
  calls: 0,
  methods: {},
  outcomes: {},
  returned_d1_metadata: {},
  returned_r2_metadata: {},
  d1_batch_statements: 0,
  driver_events: {},
});

/** Test-only method/result census. Never reads bodies, SQL, keys, parameters or row values. */
export function reconciliationBindingObserver() {
  const outsideCallbacks = empty();
  let active: BindingObservation | undefined;
  const numeric = (fields: Record<string, NumericObservation>, name: string, value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    fields[name] ??= { observations: 0, total: 0 };
    fields[name].observations++;
    fields[name].total += value;
  };
  const start = (method: string) => {
    const scope = active ?? outsideCallbacks;
    scope.calls++;
    scope.methods[method] = (scope.methods[method] ?? 0) + 1;
    scope.outcomes[method] ??= { attempted: 0, fulfilled: 0, rejected: 0 };
    scope.outcomes[method].attempted++;
    return scope;
  };
  const invoke = <T>(
    method: string,
    operation: () => Promise<T>,
    result?: (value: T, scope: BindingObservation) => void,
  ) => {
    const scope = start(method);
    try {
      return operation().then(
        (value) => {
          scope.outcomes[method]!.fulfilled++;
          result?.(value, scope);
          return value;
        },
        (error: unknown) => {
          scope.outcomes[method]!.rejected++;
          throw error;
        },
      );
    } catch (error) {
      scope.outcomes[method]!.rejected++;
      throw error;
    }
  };
  const d1Result = (result: unknown, scope: BindingObservation) => {
    for (const value of Array.isArray(result) ? result : [result]) {
      if (!value || typeof value !== "object" || !("meta" in value)) continue;
      const meta = value.meta as D1Meta;
      for (const field of ["rows_read", "rows_written", "changes", "duration", "total_attempts"] as const)
        numeric(scope.returned_d1_metadata, field, meta[field]);
      numeric(scope.returned_d1_metadata, "sql_duration_ms", meta.timings?.sql_duration_ms);
    }
  };
  const originals = new WeakMap<object, D1PreparedStatement>();
  const statement = (original: D1PreparedStatement, prefix: string): D1PreparedStatement => {
    const wrapped = new Proxy(original, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values), prefix);
        const value = Reflect.get(target, property, target);
        if (["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) =>
            invoke(
              `${prefix}.${String(property)}`,
              () => Reflect.apply(value, target, args) as Promise<unknown>,
              ["run", "all"].includes(String(property)) ? d1Result : undefined,
            );
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, original);
    return wrapped;
  };
  const database = <T extends D1Database | D1DatabaseSession>(original: T, prefix = "D1"): T =>
    new Proxy(original, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => statement(target.prepare(sql), prefix);
        if (property === "batch")
          return (statements: D1PreparedStatement[]) => {
            (active ?? outsideCallbacks).d1_batch_statements += statements.length;
            return invoke(
              `${prefix}.batch`,
              () => target.batch(statements.map((item) => originals.get(item) ?? item)),
              d1Result,
            );
          };
        const value = Reflect.get(target, property, target);
        if (property === "withSession")
          return (constraint?: D1SessionBookmark | D1SessionConstraint) =>
            database((target as D1Database).withSession(constraint), "D1.session");
        if (property === "exec")
          return (sql: string) =>
            invoke(
              "D1.exec",
              () => (target as D1Database).exec(sql),
              (result: D1ExecResult, scope) => {
                numeric(scope.returned_d1_metadata, "exec_count", result.count);
                numeric(scope.returned_d1_metadata, "exec_duration", result.duration);
              },
            );
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const r2Result = (method: string, result: unknown, scope: BindingObservation) => {
    const fields = scope.returned_r2_metadata;
    if (["get", "head", "put"].includes(method)) numeric(fields, `${method}.null_results`, result === null ? 1 : 0);
    if (!result || typeof result !== "object") return;
    if ("size" in result) numeric(fields, `${method}.object_size`, result.size);
    if (method === "get") numeric(fields, "get.body_results", "body" in result ? 1 : 0);
    if (method === "list" && "objects" in result && Array.isArray(result.objects)) {
      numeric(fields, "list.objects", result.objects.length);
      numeric(fields, "list.truncated", "truncated" in result && result.truncated ? 1 : 0);
    }
  };
  const multipart = (original: R2MultipartUpload, binding: string): R2MultipartUpload =>
    new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (["uploadPart", "abort", "complete"].includes(String(property)))
          return (...args: unknown[]) =>
            invoke(
              `${binding}.multipart.${String(property)}`,
              () => Reflect.apply(value, target, args) as Promise<unknown>,
              (result, scope) => r2Result(String(property), result, scope),
            );
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const bucket = (original: R2Bucket, binding: string): R2Bucket =>
    new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "resumeMultipartUpload")
          return (...args: unknown[]) => {
            const method = `${binding}.resumeMultipartUpload`;
            const scope = start(method);
            try {
              const result = Reflect.apply(value, target, args);
              scope.outcomes[method]!.fulfilled++;
              return multipart(result as R2MultipartUpload, binding);
            } catch (error) {
              scope.outcomes[method]!.rejected++;
              throw error;
            }
          };
        return (...args: unknown[]) =>
          invoke(
            `${binding}.${String(property)}`,
            () => Reflect.apply(value, target, args) as Promise<unknown>,
            (result, scope) => r2Result(String(property), result, scope),
          ).then((result) =>
            property === "createMultipartUpload" ? multipart(result as R2MultipartUpload, binding) : result,
          );
      },
    });
  return {
    database,
    bucket,
    outsideCallbacks,
    begin() {
      if (active) throw new Error("Binding observation scopes must be sequential.");
      active = empty();
      return active;
    },
    end() {
      active = undefined;
    },
    driverMethod<T>(method: string, operation: () => Promise<T>): Promise<T> {
      return invoke(`Workflow.driver.${method}`, operation);
    },
    driverEvent(method: string) {
      const scope = active ?? outsideCallbacks;
      scope.driver_events[method] = (scope.driver_events[method] ?? 0) + 1;
    },
  };
}
