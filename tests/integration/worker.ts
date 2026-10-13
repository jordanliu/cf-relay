import { secret } from "@cf-relay/core";
import { cloudflareEmailTransport } from "@cf-relay/email-cloudflare";
import { apiKey } from "@cf-relay/policies";
import { createCloudflareRelay } from "@cf-relay/runtime-cloudflare";
import config from "./relay.config";

export type WorkerEnv = IntegrationBindings;

const relay = createCloudflareRelay(config, {
  readinessGuard: apiKey({ secret: secret("SERVER_API_KEY") }),
  providerDependencies: {
    email: (env: WorkerEnv) => ({
      transport: cloudflareEmailTransport(env.EMAIL),
    }),
  },
});

export default {
  fetch: (request: Request, env: WorkerEnv, ctx: ExecutionContext) =>
    relay.handleRequest(request, env, ctx),
  queue: (batch, env, ctx) => relay.handleQueue(batch, env, ctx),
} satisfies ExportedHandler<WorkerEnv>;
