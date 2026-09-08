// Intrusive, opt-in debugger observations of the shipped parseSnapshot body.
// No local values, object contents, forced GC or source replacements are used.
export async function traceNativeParseAllocations(socket, call) {
  const scripts = [];
  const breakpoints = new Map();
  const report = {
    limitation:
      "Debugger pauses/deoptimization perturb execution. These are diagnostic boundary observations, not normal-run peak or timing proof. Allocation samples include objects collected by GC and are not live heap, exact allocation totals or billed CPU. No object contents are recorded.",
    boundaries: [],
    errors: [],
  };
  const started = performance.now();
  let pending = Promise.resolve();
  const listener = ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === "Debugger.scriptParsed") scripts.push(event.params);
    if (event.method !== "Debugger.paused") return;
    pending = pending.then(async () => {
      try {
        const id = event.params.hitBreakpoints?.find((id) => breakpoints.has(id));
        if (!id) throw new Error("Unexpected debugger pause outside the selected parse boundaries");
        const boundary = breakpoints.get(id);
        const frames = event.params.callFrames;
        if (!frames.some((frame) => frame.functionName === "parseSnapshot"))
          throw new Error("Selected boundary did not pause within parseSnapshot");
        const requested = performance.now() - started;
        const heap = await call("Runtime.getHeapUsage");
        const received = performance.now() - started;
        const allocationRequested = performance.now() - started;
        const { profile } = await call("HeapProfiler.getSamplingProfile");
        const allocationReceived = performance.now() - started;
        const allocations = [];
        const visit = (node, stack) => {
          const frames = [...stack, node.callFrame.functionName];
          if (node.selfSize > 0)
            allocations.push({ node_id: node.id, sampled_allocation_bytes: node.selfSize, stack: frames });
          for (const child of node.children) visit(child, frames);
        };
        visit(profile.head, []);
        report.boundaries.push({
          ...boundary,
          heap: { requested_elapsed_ms: requested, received_elapsed_ms: received, ...heap },
          cumulative_allocations: {
            requested_elapsed_ms: allocationRequested,
            received_elapsed_ms: allocationReceived,
            allocations,
          },
        });
        await call("Debugger.removeBreakpoint", { breakpointId: id });
        breakpoints.delete(id);
      } catch (error) {
        report.errors.push(String(error));
      } finally {
        await call("Debugger.resume").catch((error) => report.errors.push(String(error)));
      }
    });
  };
  socket.addEventListener("message", listener);
  try {
    await call("Debugger.enable");
    let source;
    let scriptId;
    for (const script of scripts) {
      const { scriptSource } = await call("Debugger.getScriptSource", { scriptId: script.scriptId });
      if (!scriptSource.includes("async function parseSnapshot(")) continue;
      source = scriptSource;
      scriptId = script.scriptId;
      break;
    }
    if (!source) throw new Error("Shipped parseSnapshot script was not available to the debugger");
    const start = source.indexOf("async function parseSnapshot(");
    const end = source.indexOf("async function discoverSnapshotRequests(", start);
    if (end < 0) throw new Error("Could not bound the shipped parseSnapshot function");
    const markers = [
      ["before-canonicalization", "const observationBytes = utf8(canonicalJson(observationDocument));", start, end],
      [
        "after-canonical-string-before-utf8",
        "return encoder.encode(value);",
        source.indexOf("function utf8("),
        start,
        "value.length > 8000000",
      ],
      ["after-utf8-before-digest", "const digest = await sha256(observationBytes);", start, end],
      ["after-r2-write", "if (observedToken && observedToken !== writeToken)", start, end],
    ];
    for (const [name, marker, from, through, condition] of markers) {
      const offset = source.indexOf(marker, from);
      if (from < 0 || offset < from || offset >= through) throw new Error(`Missing exact parse boundary: ${name}`);
      const lineNumber = source.slice(0, offset).split("\n").length - 1;
      const { breakpointId, actualLocation } = await call("Debugger.setBreakpoint", {
        location: { scriptId, lineNumber },
        ...(condition ? { condition } : {}),
      });
      if (actualLocation.lineNumber !== lineNumber) throw new Error(`Debugger moved boundary: ${name}`);
      breakpoints.set(breakpointId, {
        name,
        generated_line: lineNumber + 1,
        generated_column: actualLocation.columnNumber,
      });
    }
    return async () => {
      await pending;
      report.unvisited_boundaries = [...breakpoints.values()].map(({ name }) => name);
      for (const id of breakpoints.keys()) await call("Debugger.removeBreakpoint", { breakpointId: id });
      await call("Debugger.disable");
      socket.removeEventListener("message", listener);
      return report;
    };
  } catch (error) {
    await call("Debugger.disable").catch(() => undefined);
    socket.removeEventListener("message", listener);
    throw error;
  }
}
