import {
  defineDestinations,
  defineForm,
  defineForms,
  defineProviders,
  defineRelay,
  secret,
} from "@cf-relay/core";
import { apiKey, honeypot, rateLimit, turnstile } from "@cf-relay/policies";
import { discordProvider } from "@cf-relay/provider-discord";
import { emailProvider } from "@cf-relay/provider-email";
import { slackProvider } from "@cf-relay/provider-slack";
import { z } from "zod";

const providers = defineProviders([
  slackProvider(),
  discordProvider(),
  emailProvider(),
] as const);
const destinations = defineDestinations(providers, {
  engineeringSlack: {
    provider: "slack",
    revision: "v1",
    webhook: secret("ENGINEERING_SLACK_WEBHOOK_V1"),
  },
  communityDiscord: {
    provider: "discord",
    revision: "v1",
    webhook: secret("COMMUNITY_DISCORD_WEBHOOK_V1"),
  },
  teamInbox: {
    provider: "email",
    revision: "v1",
    from: "forms@example.com",
    to: ["team@example.com"],
  },
});
const forms = defineForms(destinations, {
  contact: defineForm({
    schema: z
      .object({
        name: z.string().min(1).max(80),
        email: z.email(),
        message: z.string().min(1).max(5000),
      })
      .strict(),
    allowedOrigins: ["https://example.com"],
    guards: [
      rateLimit({ binding: "FORM_RATE_LIMIT" }),
      turnstile({
        tokenField: "cf-turnstile-response",
        secret: secret("TURNSTILE_SECRET"),
        expectedHostname: "example.com",
        expectedAction: "contact",
      }),
      honeypot({ field: "website" }),
    ],
    destinations: ["engineeringSlack", "communityDiscord", "teamInbox"],
    message: ({ data }) => ({
      title: "New contact submission",
      text: data.message,
      fields: { Name: data.name },
      replyTo: data.email,
    }),
  }),
  events: defineForm({
    schema: z
      .object({
        event: z.string().min(1).max(80),
        details: z.string().min(1).max(5000),
      })
      .strict(),
    guards: [apiKey({ secret: secret("SERVER_API_KEY") })],
    destinations: ["engineeringSlack"],
    message: ({ data }) => ({ title: data.event, text: data.details }),
  }),
});
export default defineRelay({ providers, destinations, forms });
