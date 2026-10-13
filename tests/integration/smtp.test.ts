import { createExecutionContext } from "cloudflare:test";
import {
  defineDestinations,
  defineForm,
  defineForms,
  defineProviders,
  defineRelay,
  secret,
} from "@cf-relay/core";
import { smtpEmailTransport } from "@cf-relay/email-smtp";
import { apiKey } from "@cf-relay/policies";
import { emailProvider } from "@cf-relay/provider-email";
import {
  createCloudflareRelay,
  createSafeLogger,
} from "@cf-relay/runtime-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

describe("SMTP in Workers", () => {
  it("loads the sockets adapter and honors cancellation without making a connection", async () => {
    const abort = new AbortController();
    abort.abort();
    const transport = smtpEmailTransport(
      "smtps://private-user:private-password@smtp.acme.io:465",
    );
    expect(
      await transport.send(
        {
          from: "forms@acme.io",
          to: ["team@acme.io"],
          subject: "test",
          text: "offline",
        },
        {
          signal: abort.signal,
          http: { fetch: vi.fn() },
          logger: createSafeLogger(vi.fn()),
        },
      ),
    ).toEqual({ status: "retry", code: "TIMEOUT" });
  });
  it("reports missing or malformed SMTP setup and publishes only when configured", async () => {
    const providers = defineProviders([emailProvider()]);
    const destinations = defineDestinations(providers, {
      inbox: {
        provider: "email",
        revision: "v1",
        from: "forms@acme.io",
        to: ["team@acme.io"],
      },
    });
    const config = defineRelay({
      providers,
      destinations,
      forms: defineForms(destinations, {
        events: defineForm({
          schema: z.object({ event: z.string() }),
          guards: [apiKey({ secret: secret("SERVER_API_KEY") })],
          destinations: ["inbox"],
          message: ({ data }) => ({ text: data.event }),
        }),
      }),
    });
    const relay = createCloudflareRelay(config, {
      readinessGuard: apiKey({ secret: secret("SERVER_API_KEY") }),
      providerDependencies: {
        email: (env: { SMTP_URL: string }) => ({
          transport: smtpEmailTransport(env.SMTP_URL),
        }),
      },
    });
    const sendBatch = vi.fn(async () => {});
    const env = {
      SERVER_API_KEY: "private-api",
      SMTP_URL: "",
      DELIVERIES: { sendBatch },
      FAILURES: { send: vi.fn() },
    };
    const ctx = createExecutionContext();
    for (const value of ["", "https://private-invalid-url"]) {
      env.SMTP_URL = value;
      const ready = await relay.handleRequest(
        new Request("https://relay.example/v1/readiness", {
          headers: { authorization: "Bearer private-api" },
        }),
        env,
        ctx,
      );
      expect(ready.status).toBe(503);
      expect(await ready.text()).not.toContain("private");
      const submission = await relay.handleRequest(
        new Request("https://relay.example/v1/forms/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer private-api",
          },
          body: JSON.stringify({ event: "offline" }),
        }),
        env,
        ctx,
      );
      expect(submission.status).toBe(503);
      expect(sendBatch).not.toHaveBeenCalled();
    }
    env.SMTP_URL = "smtp://private-user:private-password@smtp.acme.io:587";
    const submission = await relay.handleRequest(
      new Request("https://relay.example/v1/forms/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer private-api",
        },
        body: JSON.stringify({ event: "offline" }),
      }),
      env,
      ctx,
    );
    expect(submission.status).toBe(202);
    expect(sendBatch).toHaveBeenCalledOnce();
  });
});
