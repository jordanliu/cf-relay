import {
  defineDestinations,
  defineForm,
  defineForms,
  defineProviders,
  defineRelay,
  type ProviderDependencies,
  secret,
} from "@cf-relay/core";
import { discordProvider } from "@cf-relay/provider-discord";
import { emailProvider } from "@cf-relay/provider-email";
import { slackProvider } from "@cf-relay/provider-slack";
import type { ProviderDependencyFactories } from "@cf-relay/runtime-cloudflare";
import { z } from "zod";

const providers = defineProviders([
  slackProvider(),
  discordProvider(),
  emailProvider(),
] as const);
const destinations = defineDestinations(providers, {
  chat: { provider: "slack", revision: "v1", webhook: secret("CHAT_WEBHOOK") },
  inbox: {
    provider: "email",
    revision: "v1",
    from: "forms@example.com",
    to: ["team@example.com"],
  },
});
const unknownProvider = {
  wrong: { provider: "unknown", revision: "v1", webhook: secret("WRONG") },
} as const;
// @ts-expect-error Unknown provider must not compile.
defineDestinations(providers, unknownProvider);
const plaintextWebhook = {
  wrong: { provider: "slack", revision: "v1", webhook: "https://example.com" },
} as const;
// @ts-expect-error Slack requires a secret reference, never a plaintext endpoint.
defineDestinations(providers, plaintextWebhook);
const mismatchedConfig = {
  wrong: {
    provider: "slack",
    revision: "v1",
    from: "forms@example.com",
    to: ["team@example.com"],
  },
} as const;
// @ts-expect-error Email config cannot masquerade as Slack.
defineDestinations(providers, mismatchedConfig);
const missingRevision = {
  wrong: { provider: "discord", webhook: secret("WRONG") },
} as const;
// @ts-expect-error Required revision cannot be omitted.
defineDestinations(providers, missingRevision);
const missingRecipients = {
  wrong: { provider: "email", revision: "v1", from: "forms@example.com" },
} as const;
// @ts-expect-error Email requires recipients.
defineDestinations(providers, missingRecipients);
const valid = defineForm({
  schema: z.object({ message: z.string(), count: z.number() }),
  destinations: ["chat"],
  message: ({ data }) => {
    const count: number = data.count;
    // @ts-expect-error Message transformer must use the parsed schema type.
    const wrong: string = data.count;
    // @ts-expect-error Unknown data fields must not compile.
    void data.notAField;
    void count;
    void wrong;
    return { text: data.message };
  },
});
defineForms(destinations, { valid });
const unknownDestination = {
  wrong: defineForm({
    schema: z.string(),
    destinations: ["notConfigured"],
    message: ({ data }) => ({ text: data }),
  }),
};
// @ts-expect-error Unknown destination cannot be used in a form.
defineForms(destinations, unknownDestination);
const id: "slack" = destinations.chat.provider;
void id;
const missingTransport = { slack: {}, discord: {}, email: {} };
// @ts-expect-error Email dependencies must supply the EmailTransport capability.
const wrongDependencies: ProviderDependencies<typeof providers> =
  missingTransport;
void wrongDependencies;
const emptyRevision = {
  wrong: { provider: "slack", revision: "", webhook: secret("WEBHOOK") },
} as const;
// @ts-expect-error Literal empty revisions fail before runtime.
defineDestinations(providers, emptyRevision);
const extraEmailFields = {
  wrong: {
    provider: "slack",
    revision: "v1",
    webhook: secret("WEBHOOK"),
    from: "forms@example.com",
    to: ["team@example.com"],
  },
} as const;
// @ts-expect-error Slack rejects extra email configuration even with a valid webhook.
defineDestinations(providers, extraEmailFields);

const unprotectedRelay = {
  providers,
  destinations,
  forms: {
    open: defineForm({
      schema: z.object({ text: z.string() }),
      destinations: ["chat"],
      message: ({ data }) => ({ text: data.text }),
    }),
  },
};
// @ts-expect-error A statically unprotected form requires explicit unsafe opt-out.
defineRelay(unprotectedRelay);
const unsafeRelay = {
  providers,
  destinations,
  forms: {
    open: defineForm({
      schema: z.object({ text: z.string() }),
      unsafeAllowUnprotected: true,
      destinations: ["chat"],
      message: ({ data }) => ({ text: data.text }),
    }),
  },
};
defineRelay(unsafeRelay);

// @ts-expect-error Email transport factories are required by runtime composition.
const missingFactory: ProviderDependencyFactories<object, typeof providers> =
  {};
void missingFactory;
