import {
  classifyHttp,
  type ProviderDefinition,
  postJson,
  type SecretRef,
  secretRefSchema,
} from "@cf-relay/core";
import { z } from "zod";

interface ExampleConfig {
  apiKey: SecretRef;
  topic: string;
}
// Trusted extension example. Register it with defineProviders and configure its destinations.
// The fixed endpoint is illustrative and is not contacted by tests.
export function exampleProvider(): ProviderDefinition<
  "example",
  ExampleConfig
> {
  return {
    type: "example",
    configSchema: z
      .object({
        apiKey: secretRefSchema,
        topic: z.string().regex(/^[a-z0-9-]{1,64}$/),
      })
      .strict(),
    create() {
      return {
        async deliver(input, context) {
          const response = await postJson(
            context.http,
            "https://notify.example.com/v1/messages",
            { topic: input.config.topic, text: input.message.text },
            context.signal,
            { authorization: `Bearer ${input.config.apiKey}` },
          );
          const failure = classifyHttp(response);
          await response.body?.cancel();
          return (
            failure ??
            (response.status === 202
              ? { status: "accepted" }
              : { status: "retry", code: "UNKNOWN" })
          );
        },
      };
    },
  };
}
