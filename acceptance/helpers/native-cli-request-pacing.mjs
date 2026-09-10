import { withNativeRequestPacing } from "./native-request-pacing.mjs";

// Acceptance-only preload. The parent holds its queue slot until this CLI
// exits; this child queue also spaces requests within a multi-request command.
const fetch = globalThis.fetch;
const administrationOrigin = new URL(process.env.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788").origin;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== administrationOrigin) return fetch(input, options);
  return withNativeRequestPacing(process.env, () => fetch(input, options));
};
