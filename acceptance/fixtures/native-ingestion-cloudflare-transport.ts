// Only the Cloudflare REST boundary is redirected to an independent SQLite
// export/import server. Every collection, publication and backup Workflow is shipped code.
export * from "../../apps/ingestion/src/index";
export { default } from "../../apps/ingestion/src/index";

declare const NATIVE_CLOUDFLARE_REST_PROXY: string;
const providerFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!["api.cloudflare.com", "native-export.invalid", "native-upload.invalid"].includes(url.hostname))
    return providerFetch(request);
  const proxy = new URL(NATIVE_CLOUDFLARE_REST_PROXY);
  proxy.searchParams.set("target", request.url);
  return providerFetch(new Request(proxy, {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  }));
};
