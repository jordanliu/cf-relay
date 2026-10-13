import { defineProviders, secret } from "@cf-relay/core";
import { apiKey } from "@cf-relay/policies";
import { emailProvider } from "@cf-relay/provider-email";
import { createCloudflareRelay } from "@cf-relay/runtime-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { executionContext, fixture } from "./fixtures";

const ctx = executionContext();
function readiness(key?: string) {
  return new Request("https://relay.example/v1/readiness", {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

describe("authenticated configuration readiness", () => {
  it("is opt-in and hides configuration unless the operator key is valid", async () => {
    const f = fixture();
    const env = {
      OPERATOR_KEY: "private-operator",
      TEST_SECRET: "private-provider",
      DELIVERIES: { sendBatch: vi.fn() },
      FAILURES: { send: vi.fn() },
    };
    const disabled = createCloudflareRelay(f.config, {
      providerDependencies: {},
    });
    expect(
      (await disabled.handleRequest(readiness("private-operator"), env, ctx))
        .status,
    ).toBe(404);
    const relay = createCloudflareRelay(f.config, {
      providerDependencies: {},
      readinessGuard: apiKey({ secret: secret("OPERATOR_KEY") }),
    });
    for (const key of [undefined, "wrong"]) {
      const response = await relay.handleRequest(readiness(key), env, ctx);
      expect(response.status).toBe(401);
      expect(await response.text()).not.toMatch(/TEST_SECRET|target|private-/);
    }
    const response = await relay.handleRequest(
      readiness("private-operator"),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ready: true,
      forms: [
        {
          id: "contact",
          ready: true,
          destinations: [{ id: "target", provider: "test", revision: "v1" }],
          diagnostics: [],
        },
      ],
    });
    expect(env.DELIVERIES.sendBatch).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("returns safe missing-secret and Queue diagnostics and rejects submission without publication", async () => {
    const f = fixture(),
      sendBatch = vi.fn();
    const relay = createCloudflareRelay(f.config, {
      providerDependencies: {},
      readinessGuard: apiKey({ secret: secret("OPERATOR_KEY") }),
    });
    const env = { OPERATOR_KEY: "private-operator", DELIVERIES: { sendBatch } };
    const response = await relay.handleRequest(
      readiness("private-operator"),
      env,
      ctx,
    );
    expect(response.status).toBe(503);
    const report = await response.json();
    expect(report).toMatchObject({
      forms: [
        {
          diagnostics: expect.arrayContaining([
            { code: "QUEUE_BINDING_MISSING", name: "FAILURES" },
            {
              code: "SECRET_MISSING",
              name: "TEST_SECRET",
              destinationId: "target",
            },
          ]),
        },
      ],
    });
    expect(JSON.stringify(report)).not.toMatch(/private-|hello/);
    expect(
      (
        await relay.handleRequest(
          new Request("https://relay.example/v1/forms/contact", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "hello" }),
          }),
          env,
          ctx,
        )
      ).status,
    ).toBe(503);
    expect(sendBatch).not.toHaveBeenCalled();
  });
  it("checks dependencies only for each form's selected providers", async () => {
    const f = fixture();
    const config = {
      ...f.config,
      providers: defineProviders([...f.config.providers, emailProvider()]),
      destinations: {
        ...f.config.destinations,
        inbox: {
          provider: "email" as const,
          revision: "v1",
          from: "forms@acme.io",
          to: ["team@acme.io"],
        },
      },
      forms: {
        ...f.config.forms,
        mail: { ...f.config.forms.contact, destinations: ["inbox"] },
      },
    };
    const email = vi.fn(() => {
      throw new Error("private missing transport");
    });
    const relay = createCloudflareRelay(config, {
      providerDependencies: { email },
      readinessGuard: apiKey({ secret: secret("OPERATOR_KEY") }),
    });
    const env = {
      OPERATOR_KEY: "private-operator",
      TEST_SECRET: "private-provider",
      DELIVERIES: { sendBatch: vi.fn() },
      FAILURES: { send: vi.fn() },
    };
    const report = await (
      await relay.handleRequest(readiness("private-operator"), env, ctx)
    ).json();
    expect(report).toMatchObject({
      ready: false,
      forms: [
        { id: "contact", ready: true },
        {
          id: "mail",
          diagnostics: [{ code: "PROVIDER_DEPENDENCY_MISSING", name: "email" }],
        },
      ],
    });
    expect(email).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain("private");
  });
});
