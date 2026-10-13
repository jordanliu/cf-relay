import { secret } from "@cf-relay/core";
import { apiKey } from "@cf-relay/policies";
import { createCloudflareRelay } from "@cf-relay/runtime-cloudflare";
import config from "../relay.config";

export type WorkerEnv = WorkerBindings & {
  SLACK_WEBHOOK_V1: string;
  SERVER_API_KEY: string;
};
const relay = createCloudflareRelay(config, {
  readinessGuard: apiKey({ secret: secret("SERVER_API_KEY") }),
  providerDependencies: {},
});
export default {
  fetch: (request: Request, env: WorkerEnv, ctx: ExecutionContext) =>
    relay.handleRequest(request, env, ctx),
  queue: (batch, env, ctx) => relay.handleQueue(batch, env, ctx),
} satisfies ExportedHandler<WorkerEnv>;
