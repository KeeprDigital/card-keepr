/** One transport for the CLI and release tools. Callers own response contracts. */
export function request(input, options = {}, fetchImpl = globalThis.fetch) {
  const url = new URL(input);
  const headers = new Headers(options.headers);
  if (url.username !== "" || url.password !== "") throw new Error("credential_url_forbidden");
  if (headers.has("authorization")) {
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("credential_transport_requires_https");
    }
  }
  return fetchImpl(input, { ...options, redirect: "error" });
}
