import { createFixtureServer } from "./http-fixture.mjs";

/** Real Wrangler uses this HTTP boundary instead of Miniflare's outboundService hook. */
export async function nativeCloudflareHttp(t, cloudflare) {
  const server = createFixtureServer(async (incoming, outgoing) => {
    try {
      const target = new URL(incoming.url, "http://fixture.local").searchParams.get("target");
      if (
        !target ||
        !["api.cloudflare.com", "native-export.invalid", "native-upload.invalid"].includes(new URL(target).hostname)
      )
        throw new Error("Unknown Cloudflare fixture target");
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const response = await cloudflare.fetch(
        new Request(target, {
          method: incoming.method,
          headers: incoming.headers,
          body: ["GET", "HEAD"].includes(incoming.method) ? undefined : Buffer.concat(chunks),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/`;
}
