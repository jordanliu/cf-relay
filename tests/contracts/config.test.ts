import {
  type AnyForm,
  type AnyProvider,
  defineDestinationEntries,
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
import { describe, expect, it } from "vitest";
import { fixture } from "./fixtures";

describe("configuration", () => {
  it("rejects duplicate provider types and duplicate destination entries", () => {
    expect(() => defineProviders([slackProvider(), slackProvider()])).toThrow(
      /duplicate provider/,
    );
    const providers = defineProviders([slackProvider()]);
    const item = {
      provider: "slack" as const,
      revision: "v1",
      webhook: secret("WEBHOOK"),
    };
    expect(() =>
      defineDestinationEntries(providers, [
        ["same", item],
        ["same", item],
      ]),
    ).toThrow(/Duplicate destination/);
  });
  it.each([
    slackProvider(),
    discordProvider(),
    emailProvider(),
  ] as AnyProvider[])("validates declared config for $type", (provider) => {
    expect(() =>
      provider.configSchema.parse({
        webhook: "raw credential",
        from: "injection\r\n@example.com",
        to: [],
      }),
    ).toThrow();
  });
  it("rejects unknown providers, destination names, invalid revisions and origins at runtime", () => {
    const { config } = fixture();
    expect(() =>
      defineDestinations(config.providers, {
        bad: { provider: "unknown", revision: "v1" },
      } as any),
    ).toThrow(/Unknown/);
    expect(() =>
      defineDestinations(config.providers, {
        bad: {
          provider: "test",
          revision: "" as string,
          token: secret("TEST_SECRET"),
        },
      }),
    ).toThrow(/revision/);
    expect(() =>
      defineForms(config.destinations, {
        wrong: { ...config.forms.contact, destinations: ["unknown"] },
      } as any),
    ).toThrow(/Unknown/);
    expect(() =>
      defineRelay({
        ...config,
        forms: { contact: { ...config.forms.contact, allowedOrigins: ["*"] } },
      }),
    ).toThrow(/origin/);
  });
  it("requires effective public or API protection; honeypot alone is insufficient", () => {
    const { config } = fixture();
    const base = config.forms.contact;
    for (const guards of [
      [],
      [honeypot({ field: "website" })],
      [rateLimit({ binding: "LIMIT" })],
    ])
      expect(() =>
        defineRelay({
          ...config,
          forms: {
            contact: { ...base, unsafeAllowUnprotected: false, guards },
          },
        }),
      ).toThrow(/protection/);
    expect(() =>
      defineRelay({
        ...config,
        forms: {
          contact: {
            ...base,
            unsafeAllowUnprotected: false,
            guards: [apiKey({ secret: secret("KEY") })],
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      defineRelay({
        ...config,
        forms: {
          contact: {
            ...base,
            unsafeAllowUnprotected: false,
            guards: [
              rateLimit({ binding: "LIMIT" }),
              turnstile({
                secret: secret("TOKEN"),
                tokenField: "token",
                expectedHostname: "example.com",
              }),
            ],
          },
        },
      }),
    ).not.toThrow();
  });
  it("validates programmatic registries and form destination fan-out", () => {
    const { config } = fixture();
    const base: AnyForm = config.forms.contact;
    expect(() =>
      defineForms(config.destinations, {
        empty: defineForm({ ...base, destinations: [] }),
      }),
    ).toThrow();
    expect(() =>
      defineForms(config.destinations, {
        duplicate: defineForm({ ...base, destinations: ["target", "target"] }),
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      defineForms(config.destinations, {
        tooMany: defineForm({
          ...base,
          destinations: Array(11).fill("target"),
        }),
      }),
    ).toThrow();
  });
});
