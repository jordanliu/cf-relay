import { cloudflareEmailTransport } from "@cf-relay/email-cloudflare";
import { createCloudflareRelay } from "@cf-relay/runtime-cloudflare";
import config from "../relay.config";

// Secrets are declared by name, with values supplied only by Cloudflare or local .dev.vars.
// Platform capability types below are generated from wrangler.jsonc.
export type WorkerEnv = WorkerBindings & {
  ENGINEERING_SLACK_WEBHOOK_V1: string;
  COMMUNITY_DISCORD_WEBHOOK_V1: string;
  TURNSTILE_SECRET: string;
  SERVER_API_KEY: string;
};
const relay = createCloudflareRelay(config, {
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
