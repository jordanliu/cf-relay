import {
  type GuardCapabilities,
  type GuardInput,
  secret,
} from "@cf-relay/core";
import { apiKey, honeypot, rateLimit, turnstile } from "@cf-relay/policies";
import {
  cloudflareRateLimit,
  createSafeLogger,
} from "@cf-relay/runtime-cloudflare";
import { describe, expect, it, vi } from "vitest";

const input: GuardInput = {
  formId: "contact",
  security: { token: "fake-token" },
  headers: {},
  clientIp: "192.0.2.1",
};
function caps(): GuardCapabilities {
  return {
    http: {
      fetch: vi.fn(async () =>
        Response.json({
          success: true,
          hostname: "example.com",
          action: "contact",
        }),
      ),
    },
    secretReader: { read: () => "fake-only" },
    rateLimit: vi.fn(async () => true),
    signal: new AbortController().signal,
  };
}
describe("policies and safe logging", () => {
  it("authenticates API keys with Web Crypto and fails closed", async () => {
    const guard = apiKey({ secret: secret("API_KEY") });
    const capabilities = caps();
    expect(
      await guard.check(
        { ...input, headers: { authorization: "Bearer fake-only" } },
        capabilities,
      ),
    ).toEqual({ allowed: true });
    expect(
      await guard.check(
        { ...input, headers: { authorization: "Bearer wrong" } },
        capabilities,
      ),
    ).toEqual({ allowed: false, status: 401 });
    expect(await guard.check(input, capabilities)).toEqual({
      allowed: false,
      status: 401,
    });
    expect(
      await guard.check(
        { ...input, headers: { authorization: "Bearer fake-only" } },
        {
          ...capabilities,
          secretReader: {
            read: () => {
              throw new Error("secret");
            },
          },
        },
      ),
    ).toEqual({ allowed: false, status: 503 });
  });
  it("checks Turnstile success, hostname and action without revealing rejection details", async () => {
    const guard = turnstile({
      secret: secret("TURNSTILE"),
      tokenField: "token",
      expectedHostname: "example.com",
      expectedAction: "contact",
    });
    expect(await guard.check(input, caps())).toEqual({ allowed: true });
    for (const result of [
      { success: false },
      { success: true, hostname: "evil.example", action: "contact" },
      { success: true, hostname: "example.com", action: "wrong" },
    ])
      expect(
        await guard.check(input, {
          ...caps(),
          http: { fetch: async () => Response.json(result) },
        }),
      ).toEqual({ allowed: false, status: 403 });
    expect(
      await guard.check(input, {
        ...caps(),
        http: { fetch: async () => new Response("private", { status: 500 }) },
      }),
    ).toEqual({ allowed: false, status: 503 });
    expect(
      await guard.check(
        { ...input, security: { token: "x".repeat(2049) } },
        caps(),
      ),
    ).toEqual({ allowed: false, status: 403 });
  });
  it("honeypot rejects filled or structured values", async () => {
    const guard = honeypot({ field: "website" });
    for (const value of ["bot", {}, null])
      expect(
        await guard.check({ ...input, security: { website: value } }, caps()),
      ).toEqual({ allowed: false, status: 403 });
    expect(
      await guard.check({ ...input, security: { website: "" } }, caps()),
    ).toEqual({ allowed: true });
  });
  it("uses the binding's success flag and route/hashed actor key; missing actor fails closed", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    expect(
      await cloudflareRateLimit({ LIMIT: { limit } }, "LIMIT", "key"),
    ).toBe(false);
    await expect(cloudflareRateLimit({}, "LIMIT", "key")).rejects.toThrow();
    const capabilities = caps();
    const guard = rateLimit({ binding: "LIMIT" });
    expect(await guard.check(input, capabilities)).toEqual({ allowed: true });
    expect(capabilities.rateLimit).toHaveBeenCalledWith(
      "LIMIT",
      expect.stringMatching(/^contact:[0-9a-f]{64}$/),
    );
    expect(
      await guard.check(
        { formId: "contact", security: {}, headers: {} },
        capabilities,
      ),
    ).toEqual({ allowed: false, status: 503 });
    expect(
      await guard.check(input, {
        ...capabilities,
        rateLimit: async () => false,
      }),
    ).toEqual({ allowed: false, status: 429 });
  });
  it("redacts bodies, tokens, URLs, addresses, unexpected events and error objects", () => {
    const events: unknown[] = [];
    const logger = createSafeLogger((_level, event) => events.push(event));
    logger.info("delivery.accepted", {
      deliveryId: "sub_123:target",
      webhook: "https://hooks.slack.com/private",
      message: "PII",
      email: "person@example.com",
      code: "unsafe@example.com",
      error: new Error("secret"),
    });
    logger.error("random.event", { code: "SECRET" });
    expect(events).toEqual([
      { event: "delivery.accepted", deliveryId: "sub_123:target" },
    ]);
    expect(() =>
      createSafeLogger(() => {
        throw new Error("sink failure");
      }).info("delivery.accepted", {}),
    ).not.toThrow();
  });
});
