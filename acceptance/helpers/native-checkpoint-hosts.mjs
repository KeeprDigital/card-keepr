const hosts = new Set(["api.cloudflare.com", "native-export.invalid", "native-upload.invalid"]);

export function isNativeCheckpointRequest(request) {
  return hosts.has(new URL(request.url).hostname);
}
