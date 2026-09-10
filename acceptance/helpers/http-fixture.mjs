import { createServer } from "node:http";

/**
 * Keep request-stream and handler failures inside the disposable HTTP fixture.
 * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void | Promise<void>} handle
 */
export function createFixtureServer(handle) {
  return createServer((request, response) => {
    Promise.resolve()
      .then(() => handle(request, response))
      .catch((error) => {
        if (response.destroyed) return;
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("HTTP fixture failed");
      });
  });
}
