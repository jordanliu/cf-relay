import { defineProviders, type ProviderDefinition } from "@cf-relay/core";
import { emailProvider } from "@cf-relay/provider-email";
import { createCloudflareRelay } from "@cf-relay/runtime-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fixture, job, queueMessage } from "./fixtures";

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;
function submission() {
  return new Request("https://relay.example/v1/forms/contact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
}
describe("validated runtime configuration", () => {
  it("does not construct unrelated dependencies during acceptance", async () => {
    const f = fixture();
    const unused = vi.fn(() => {
      throw new Error("unrelated capability missing");
    });
    const sendBatch = vi.fn(async () => {});
    const relay = createCloudflareRelay(f.config, {
      providerDependencies: { unused },
    });
    const response = await relay.handleRequest(
      submission(),
      {
        TEST_SECRET: "test-only",
        DELIVERIES: { sendBatch },
        FAILURES: { send: vi.fn() },
      },
      ctx,
    );
    expect(response.status).toBe(202);
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(unused).not.toHaveBeenCalled();
  });
  it("fails closed on missing failure producer before Queue publication", async () => {
    const f = fixture();
    const sendBatch = vi.fn();
    const relay = createCloudflareRelay(f.config, { providerDependencies: {} });
    const response = await relay.handleRequest(
      submission(),
      {
        TEST_SECRET: "test-only",
        DELIVERIES: { sendBatch },
      },
      ctx,
    );
    expect(response.status).toBe(503);
    expect(sendBatch).not.toHaveBeenCalled();
  });
  it("fails closed when an untyped composition omits required email dependencies", async () => {
    const f = fixture();
    const declared = {
      ...f.config,
      providers: [emailProvider()],
      destinations: {
        target: {
          provider: "email" as const,
          revision: "v1",
          from: "forms@example.com",
          to: ["team@example.com"],
        },
      },
    };
    const relay = createCloudflareRelay(declared, {
      providerDependencies: {},
    } as any);
    const sendBatch = vi.fn();
    const response = await relay.handleRequest(
      submission(),
      { DELIVERIES: { sendBatch }, FAILURES: { send: vi.fn() } },
      ctx,
    );
    expect(response.status).toBe(503);
    expect(sendBatch).not.toHaveBeenCalled();
  });
  it("uses parsed defaults/normalization and snapshots caller-owned forms", async () => {
    const deliver = vi.fn(
      async (_input: { config: { mode: string } }) =>
        ({ status: "accepted" }) as const,
    );
    const provider: ProviderDefinition<"normalized", { mode: string }> = {
      type: "normalized",
      configSchema: z.object({
        mode: z
          .string()
          .default("safe")
          .transform((v) => v.toUpperCase()),
      }),
      create: () => ({ deliver }),
    };
    const f = fixture();
    const form = { ...f.config.forms.contact, destinations: ["target"] };
    const declared = {
      providers: defineProviders([provider]),
      destinations: { target: { provider: "normalized", revision: "v1" } },
      forms: { contact: form },
    };
    // An untyped boundary exercises runtime schemas, including their input defaults.
    const relay = createCloudflareRelay(declared as any, {
      providerDependencies: {},
    });
    form.destinations.splice(0);
    const message = queueMessage({
      ...job(),
      destination: { id: "target", provider: "normalized", revision: "v1" },
    });
    await relay.handleQueue(
      { messages: [message] } as unknown as MessageBatch,
      { FAILURES: { send: vi.fn() } },
      ctx,
    );
    expect(deliver.mock.calls[0]?.[0].config).toEqual({ mode: "SAFE" });
    expect(message.ack).toHaveBeenCalledOnce();
    const sendBatch = vi.fn(async () => {});
    expect(
      (
        await relay.handleRequest(
          submission(),
          { DELIVERIES: { sendBatch }, FAILURES: { send: vi.fn() } },
          ctx,
        )
      ).status,
    ).toBe(202);
    expect(sendBatch).toHaveBeenCalledOnce();
  });
  it("isolates dependency failures per job and checks revisions before factories", async () => {
    const f = fixture();
    const healthy = vi.fn(() => ({}));
    const broken = vi.fn(() => {
      throw new Error("missing capability");
    });
    const extraProvider: ProviderDefinition<"broken", { label: string }> = {
      type: "broken",
      configSchema: z.object({ label: z.string() }).strict(),
      create: () => ({ deliver: vi.fn() }),
    };
    const config = {
      ...f.config,
      providers: [...f.config.providers, extraProvider],
      destinations: {
        ...f.config.destinations,
        broken: { provider: "broken" as const, revision: "v1", label: "test" },
      },
    };
    const relay = createCloudflareRelay(config, {
      providerDependencies: { test: healthy, broken },
    });
    const ok = queueMessage(job());
    const fail = queueMessage({
      ...job(),
      destination: { id: "broken", provider: "broken", revision: "v1" },
    });
    const rotated = queueMessage({
      ...job(),
      destination: { id: "broken", provider: "broken", revision: "old" },
    });
    await relay.handleQueue(
      { messages: [fail, ok, rotated] } as unknown as MessageBatch,
      { TEST_SECRET: "test-only", FAILURES: { send: vi.fn(async () => {}) } },
      ctx,
    );
    expect(ok.ack).toHaveBeenCalledOnce();
    expect(fail.retry).toHaveBeenCalledOnce();
    expect(rotated.ack).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
    expect(broken).toHaveBeenCalledOnce();
  });
});
