import assert from "node:assert/strict";
import { isNativeCheckpointRequest } from "./native-checkpoint-hosts.mjs";

export function riftboundReplayTransport(checkpoint, captures, served, measurements) {
  return async (request) => {
    const hostname = new URL(request.url).hostname;
    if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
    const capture = captures.get(request.url);
    if (measurements) measurements.source_requests++;
    if (!capture) {
      assert.equal(hostname, "cmsassets.rgpub.io", `undeclared request ${request.url}`);
      if (measurements) measurements.injected_missing_images++;
      return new Response("Image not retained in this deterministic replay", { status: 404 });
    }
    served.push(capture.id);
    if (measurements) measurements.delivered_body_bytes += capture.bodyBytes.length;
    return new Response(capture.bodyBytes, { headers: { "content-type": capture.contentType } });
  };
}
