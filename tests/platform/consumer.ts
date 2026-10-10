import {
  defineDestinations,
  defineForm,
  defineProviders,
  defineRelay,
  type ProviderDefinition,
} from "@cf-relay/core";
import { consumeQueue, createSafeLogger } from "@cf-relay/runtime-cloudflare";
import { z } from "zod";

// Local-only platform fixture; temporary KV is an assertion sink, never an app dependency.
const provider: ProviderDefinition<"test", { testOnly?: boolean }> = {
  type: "test",
  configSchema: z.object({}).strict(),
  create: () => ({
    deliver: async () => ({ status: "retry", code: "UPSTREAM_UNAVAILABLE" }),
  }),
};
const providers = defineProviders([provider]);
const destinations = defineDestinations(providers, {
  target: { provider: "test", revision: "v1" },
});
const config = defineRelay({
  providers,
  destinations,
  forms: {
    test: defineForm({
      schema: z.object({}),
      destinations: ["target"],
      unsafeAllowUnprotected: true,
      message: () => ({ text: "test" }),
    }),
  },
});
export default {
  async fetch(_request: Request, env: { SNAPSHOT: KVNamespace }) {
    return new Response(await env.SNAPSHOT.get("dlq"));
  },
  async queue(batch: MessageBatch<unknown>, env: { SNAPSHOT: KVNamespace }) {
    if (batch.queue === "failures") {
      for (const message of batch.messages) {
        await env.SNAPSHOT.put("dlq", JSON.stringify(message.body));
        message.ack();
      }
      return;
    }
    await consumeQueue(config, batch, {
      dependencies: {},
      http: {
        fetch: async () => {
          throw new Error("Live HTTP disabled in fixture");
        },
      },
      logger: createSafeLogger(() => {}),
      secretReader: {
        read: () => {
          throw new Error("No secrets in fixture");
        },
      },
      failureSink: {
        record: async () => {
          throw new Error("No terminal failures expected");
        },
      },
    });
  },
};
