import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DeliveryJob } from "@cf-relay/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type WorkerEnv } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
function delivery(id: string, provider = "slack"): DeliveryJob {
  return {
    kind: "delivery",
    version: 1,
    deliveryId: `sub_test:${id}`,
    submissionId: "sub_test",
    formId: "events",
    createdAt: "2026-10-10T00:00:00.000Z",
    destination: { id, provider, revision: "v1" },
    message: { text: "test-only" },
  };
}
async function request(
  path: string,
  init?: RequestInit,
  bindings: WorkerEnv = env,
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://relay.example${path}`, init),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
describe("real Workers runtime and Queue settlement", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("health is responsive without inspecting provider health", async () => {
    expect(await (await request("/healthz")).json()).toEqual({ status: "ok" });
  });
  it("authenticates readiness and reports configuration gaps without Queue writes or provider requests", async () => {
    const deliveries = vi.spyOn(env.DELIVERIES, "sendBatch");
    expect((await request("/v1/readiness")).status).toBe(401);
    const init = { headers: { authorization: "Bearer fake-test-only" } };
    const ready = await request("/v1/readiness", init);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true });
    const incomplete = await request("/v1/readiness", init, {
      ...env,
      ENGINEERING_SLACK_WEBHOOK_V1: "",
    });
    expect(incomplete.status).toBe(503);
    expect(await incomplete.text()).toContain("ENGINEERING_SLACK_WEBHOOK_V1");
    expect(deliveries).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("confirms one real Queue sendBatch before a 202 response", async () => {
    const spy = vi.spyOn(env.DELIVERIES, "sendBatch");
    const response = await request("/v1/forms/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-test-only",
      },
      body: JSON.stringify({
        event: "Test event",
        details: "No live notification",
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "queued",
      destinations: 1,
    });
    expect(spy).toHaveBeenCalledOnce();
    const messages = Array.from(spy.mock.calls[0]?.[0] ?? []);
    expect(messages[0]?.contentType).toBe("json");
    expect(JSON.stringify(messages)).not.toContain("fake-test-only");
  });
  it("accepts Slack-only forms without an unrelated email capability", async () => {
    const spy = vi.spyOn(env.DELIVERIES, "sendBatch");
    const bindings = { ...env };
    Reflect.deleteProperty(bindings, "EMAIL");
    const response = await request(
      "/v1/forms/events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fake-test-only",
        },
        body: JSON.stringify({ event: "test", details: "offline" }),
      },
      bindings,
    );
    expect(response.status).toBe(202);
    expect(spy).toHaveBeenCalledOnce();
  });
  it("rejects missing failure producer before publication", async () => {
    const spy = vi.spyOn(env.DELIVERIES, "sendBatch");
    const bindings = { ...env };
    Reflect.deleteProperty(bindings, "FAILURES");
    const response = await request(
      "/v1/forms/events",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fake-test-only",
        },
        body: JSON.stringify({ event: "test", details: "offline" }),
      },
      bindings,
    );
    expect(response.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
  it("rejects unsupported media, oversize, invalid fields, auth and missing secrets with zero Queue writes", async () => {
    const spy = vi.spyOn(env.DELIVERIES, "sendBatch");
    const headers = {
      authorization: "Bearer fake-test-only",
      "content-type": "application/json",
    };
    expect(
      (
        await request("/v1/forms/events", {
          method: "POST",
          headers: { ...headers, "content-type": "multipart/form-data" },
          body: "fake",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await request("/v1/forms/events", {
          method: "POST",
          headers,
          body: "x".repeat(32769),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request("/v1/forms/events", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request("/v1/forms/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/v1/forms/events",
          { method: "POST", headers, body: "{}" },
          { ...env, SERVER_API_KEY: "" },
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await request(
          "/v1/forms/events",
          { method: "POST", headers, body: "{}" },
          { ...env, ENGINEERING_SLACK_WEBHOOK_V1: "" },
        )
      ).status,
    ).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
  it("limits CORS to the configured form and returns proper method errors", async () => {
    const allowed = await request("/v1/forms/contact", {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://example.com",
    );
    expect(
      (
        await request("/v1/forms/contact", {
          method: "POST",
          headers: {
            origin: "https://evil.example",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect((await request("/v1/forms/contact")).status).toBe(405);
    expect(
      (await request("/v1/forms/unknown", { method: "POST" })).status,
    ).toBe(404);
  });
  it("records terminal failures through the real failure Queue and acknowledges only matching messages", async () => {
    const failSpy = vi.spyOn(env.FAILURES, "send");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const text = String(init?.body);
        return new Response(text.includes("retry-this") ? "no" : "ok", {
          status: text.includes("retry-this") ? 429 : 200,
        });
      }),
    );
    const retried = {
      ...delivery("engineeringSlack"),
      deliveryId: "sub_retry:engineeringSlack",
      message: { text: "retry-this" },
    };
    const mismatch = {
      ...delivery("engineeringSlack"),
      destination: {
        id: "engineeringSlack",
        provider: "slack",
        revision: "v0",
      },
    };
    const batch = createMessageBatch<unknown>("cf-relay-deliveries", [
      {
        id: "ok",
        timestamp: new Date(),
        attempts: 1,
        body: delivery("engineeringSlack"),
      },
      { id: "retry", timestamp: new Date(), attempts: 2, body: retried },
      { id: "rotated", timestamp: new Date(), attempts: 1, body: mismatch },
      {
        id: "invalid",
        timestamp: new Date(),
        attempts: 1,
        body: { version: 99, body: "private" },
      },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["ok", "rotated", "invalid"]);
    expect(result.retryMessages.map((message) => message.msgId)).toEqual([
      "retry",
    ]);
    expect(failSpy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(failSpy.mock.calls)).not.toMatch(
      /test-only|private|WEBHOOK|fake-test-only/,
    );
  });
  it("explicitly retries when the failure binding is unavailable", async () => {
    const batch = createMessageBatch("cf-relay-deliveries", [
      { id: "invalid", timestamp: new Date(), attempts: 1, body: null },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(
      batch,
      {
        ...env,
        FAILURES: {
          send: async () => {
            throw new Error("sink down");
          },
          sendBatch: env.FAILURES.sendBatch.bind(env.FAILURES),
          metrics: env.FAILURES.metrics.bind(env.FAILURES),
        },
      },
      ctx,
    );
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((message) => message.msgId)).toEqual([
      "invalid",
    ]);
  });
});
