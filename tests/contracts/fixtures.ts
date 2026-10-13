import {
  type DeliveryJob,
  defineDestinations,
  defineForm,
  defineForms,
  defineProviders,
  defineRelay,
  type ProviderDefinition,
  type ProviderExecutor,
  type SecretRef,
  secret,
  secretRefSchema,
} from "@cf-relay/core";
import { createSafeLogger } from "@cf-relay/runtime-cloudflare";
import { vi } from "vitest";
import { z } from "zod";
export function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    abort: vi.fn(),
    get exports(): never {
      throw new Error("Unexpected context exports access");
    },
    get tracing(): never {
      throw new Error("Unexpected context tracing access");
    },
  };
}
export function fixture(
  handler: ProviderExecutor<{ token: string }>["deliver"] = async () => ({
    status: "accepted",
  }),
) {
  const deliver = vi.fn(handler);
  const provider: ProviderDefinition<"test", { token: SecretRef }> = {
    type: "test",
    configSchema: z.object({ token: secretRefSchema }).strict(),
    create: () => ({ deliver }),
  };
  const providers = defineProviders([provider] as const);
  const destinations = defineDestinations(providers, {
    target: { provider: "test", revision: "v1", token: secret("TEST_SECRET") },
  });
  const form = defineForm({
    schema: z
      .object({ message: z.string(), hiddenBusiness: z.string().optional() })
      .strict(),
    destinations: ["target"],
    allowedOrigins: ["https://example.com"],
    unsafeAllowUnprotected: true,
    message: ({ data }) => ({ title: "Contact", text: data.message }),
  });
  const config = defineRelay({
    providers,
    destinations,
    forms: defineForms(destinations, { contact: form }),
  });
  const events: Record<string, unknown>[] = [];
  const logger = createSafeLogger((_level, event) => events.push(event));
  const secretReader = { read: vi.fn(() => "test-secret-only") };
  const http = { fetch: vi.fn(async () => new Response("ok")) };
  return { config, deliver, events, logger, secretReader, http };
}
export function job(text = "Hello"): DeliveryJob {
  return {
    kind: "delivery",
    version: 1,
    deliveryId: "sub_test:target",
    submissionId: "sub_test",
    formId: "contact",
    createdAt: "2026-10-10T00:00:00.000Z",
    destination: { id: "target", provider: "test", revision: "v1" },
    message: { text },
  };
}
export function queueMessage(body: unknown, attempts = 1): Message<unknown> {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}
