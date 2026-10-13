import {
  defineDestinations,
  defineForm,
  defineForms,
  defineProviders,
  defineRelay,
  secret,
} from "@cf-relay/core";
import { apiKey } from "@cf-relay/policies";
import { slackProvider } from "@cf-relay/provider-slack";
import { z } from "zod";

const providers = defineProviders([slackProvider()] as const);
const destinations = defineDestinations(providers, {
  primary: {
    provider: "slack",
    revision: "v1",
    webhook: secret("SLACK_WEBHOOK_V1"),
  },
});
const forms = defineForms(destinations, {
  events: defineForm({
    schema: z
      .object({
        event: z.string().min(1).max(80),
        details: z.string().min(1).max(5000),
      })
      .strict(),
    guards: [apiKey({ secret: secret("SERVER_API_KEY") })],
    destinations: ["primary"],
    message: ({ data }) => ({ title: data.event, text: data.details }),
  }),
});
export default defineRelay({ providers, destinations, forms });
