import { WorkerEntrypoint } from "cloudflare:workers";

export class OfficialSourceTransport extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}
