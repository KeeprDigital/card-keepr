import assert from "node:assert/strict";

export function riftboundReplayTransport(checkpoint, captures, served) {
  return async (request) => {
    const hostname = new URL(request.url).hostname;
    if (["api.cloudflare.com", "native-export.invalid", "native-upload.invalid"].includes(hostname))
      return checkpoint.outboundService(request);
    const capture = captures.get(request.url);
    if (!capture) {
      assert.equal(hostname, "cmsassets.rgpub.io", `undeclared request ${request.url}`);
      return new Response("Image not retained in this deterministic replay", { status: 404 });
    }
    served.push(capture.id);
    return new Response(capture.bodyBytes, { headers: { "content-type": capture.contentType } });
  };
}
