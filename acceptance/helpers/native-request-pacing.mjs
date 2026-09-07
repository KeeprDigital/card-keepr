// One queue for opt-in native administration traffic, including CLI commands,
// helper reads and polling. Hold the slot until the CLI exits or fetch headers
// arrive so slow commands
// cannot release a burst of overdue reservations. Failures are never retried.
export function createNativeRequestQueue({
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const origins = new Map();
  return function request(environment, action) {
    const interval = Number(environment?.KEEPR_NATIVE_REQUEST_INTERVAL_MS ?? 0);
    if (interval === 0) return action();
    if (!Number.isFinite(interval) || interval < 0) throw new RangeError("Invalid native request interval");
    const origin = new URL(environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788").origin;
    let state = origins.get(origin);
    if (!state) {
      state = { completedAt: null, tail: Promise.resolve() };
      origins.set(origin, state);
    }
    const pending = state.tail.then(async () => {
      if (state.completedAt !== null) {
        const delay = Math.max(0, state.completedAt + interval - now());
        if (delay) await sleep(delay);
      }
      try {
        return await action();
      } finally {
        state.completedAt = now();
      }
    });
    state.tail = pending.catch(() => {});
    return pending;
  };
}

export const withNativeRequestPacing = createNativeRequestQueue();
