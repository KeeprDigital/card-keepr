#!/usr/bin/env node
import { authorizeStagingRelease } from "./staging-workflow-client.mjs";

const authorization = await authorizeStagingRelease(process.env);
process.stdout.write(
  `${JSON.stringify({ release_id: authorization.intent.release_id, expected_head_sha: authorization.intent.expected_head_sha, preparation_expires_at: authorization.preparation_expires_at })}\n`,
);
