import {
  type AnyForm,
  type AnyProvider,
  defineDestinationEntries,
  defineDestinations,
  defineForm,
  defineForms,
  defineProviders,
  defineRelay,
  type Guard,
  secret,
} from "@cf-relay/core";
import { apiKey, honeypot, rateLimit, turnstile } from "@cf-relay/policies";
import { discordProvider } from "@cf-relay/provider-discord";
import { emailProvider } from "@cf-relay/provider-email";
import { slackProvider } from "@cf-relay/provider-slack";
import { describe, expect, it } from "vitest";
import { fixture } from "./fixtures";

describe("configuration", () => {
  it.each(["false", "true", 0, 1, {}, []])(
    "rejects non-boolean unsafe opt-out: %j",
    (value) => {
      const { config } = fixture();
      expect(() =>
        defineRelay({
          ...config,
          forms: {
            contact: { ...config.forms.contact, unsafeAllowUnprotected: value },
          },
        } as any),
      ).toThrow(/boolean/);
    },
  );
  it("snapshots forms, metadata arrays, origins and destinations", () => {
    const { config } = fixture();
    const guards = [apiKey({ secret: secret("KEY") })];
    const origins = ["https://example.com"];
    const targets = ["target"];
    const original = {
      ...config.forms.contact,
      guards,
      allowedOrigins: origins,
      destinations: targets,
      unsafeAllowUnprotected: false,
    };
    const validated = defineRelay({ ...config, forms: { contact: original } });
    guards.splice(0);
    origins[0] = "https://evil.example";
    targets.splice(0);
    original.unsafeAllowUnprotected = true;
    expect(validated.forms.contact.guards).toHaveLength(1);
    expect(validated.forms.contact.allowedOrigins).toEqual([
      "https://example.com",
    ]);
    expect(validated.forms.contact.destinations).toEqual(["target"]);
    expect(validated.forms.contact.unsafeAllowUnprotected).toBe(false);
    expect(Object.isFrozen(validated.forms.contact)).toBe(true);
    expect(Object.isFrozen(validated.forms.contact.guards?.[0]?.fields)).toBe(
      true,
    );
  });
  it("preserves class guard prototype methods and private receiver state", async () => {
    class ClassGuard implements Guard {
      type = "api-key";
      phase = "auth" as const;
      fields = [];
      #allowed = false;
      async check() {
        return { allowed: this.#allowed, status: 401 as const };
      }
    }
    const { config } = fixture();
    const validated = defineRelay({
      ...config,
      forms: {
        contact: { ...config.forms.contact, guards: [new ClassGuard()] },
      },
    });
    expect(await validated.forms.contact.guards?.[0]?.check()).toEqual({
      allowed: false,
      status: 401,
    });
  });
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
            contact: { ...base, unsafeAllowUnprotected: false, guards } as any,
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
