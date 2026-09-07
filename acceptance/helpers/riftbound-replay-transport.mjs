import assert from "node:assert/strict";
import { isNativeCheckpointRequest } from "./native-checkpoint-hosts.mjs";

export function riftboundReplayTransport(checkpoint, captures, served) {
  return async (request) => {
    const hostname = new URL(request.url).hostname;
    if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
    const capture = captures.get(request.url);
    if (!capture) {
      assert.equal(hostname, "cmsassets.rgpub.io", `undeclared request ${request.url}`);
      return new Response("Image not retained in this deterministic replay", { status: 404 });
    }
    served.push(capture.id);
    return new Response(capture.bodyBytes, { headers: { "content-type": capture.contentType } });
  };
}
