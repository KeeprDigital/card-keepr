import { streamingHttpRoute } from "../../http/openapi";
import type { RouteContext } from "../../http/routes";
import {
  devDeploymentRoute,
  stagingAuthorizationRoute,
  signedStagingDeploymentRoute,
  stagingOutcomeRoute,
} from "./platform-http-contract";
import { handleDevDeployment } from "./dev-deployment";
import { handleStagingAuthorization } from "./staging-authorization";
import { handleStagingDeployment, handleStagingOutcome } from "./staging-deployment";

type Context = RouteContext<Parameters<typeof handleDevDeployment>[1]>;
// The signed handlers validate bounded JSON receipts before serialization;
// this adapter preserves their explicit status, headers and retained values.
const route = streamingHttpRoute<Context>();
export const platformRoutes = [
  route(devDeploymentRoute, async (c) => handleDevDeployment(c.env.request, c.env.env)),
  route(stagingAuthorizationRoute, async (c) => handleStagingAuthorization(c.env.request, c.env.env)),
  route(signedStagingDeploymentRoute, async (c) => handleStagingDeployment(c.env.request, c.env.env)),
  route(stagingOutcomeRoute, async (c) => handleStagingOutcome(c.env.request, c.env.env, c.req.valid("param").release)),
];
