import {
  boundedBackoff,
  type DeliveryOutcome,
  dispatch,
  type FailureRecordV1,
  failureEnvelopeSchema,
} from "@cf-relay/core";
import {
  cloudflareFailureSink,
  consumeQueue,
} from "@cf-relay/runtime-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { fixture, job, queueMessage } from "./fixtures";

describe("Queue reliability", () => {
  it("checks revisions before resolving secrets or invoking providers", async () => {
    const f = fixture();
    const record = vi.fn(async () => {});
    const message = queueMessage({
      ...job(),
      destination: { ...job().destination, revision: "v0" },
    });
    await consumeQueue(
      f.config,
      { messages: [message] },
      { ...f, dependencies: {}, failureSink: { record } },
    );
    expect(f.secretReader.read).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DESTINATION_REVISION_MISMATCH" }),
    );
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      (message.ack as any).mock.invocationCallOrder[0],
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
  it("resolves only selected destination references and supplies no environment", async () => {
    const f = fixture();
    await dispatch(f.config, job(), 1, { ...f, dependencies: {} });
    expect(f.secretReader.read).toHaveBeenCalledExactlyOnceWith("TEST_SECRET");
    const input = f.deliver.mock.calls[0]?.[0] as any;
    expect(input.config).toEqual({ token: "test-secret-only" });
    expect(Object.keys(input)).toEqual([
      "deliveryId",
      "submissionId",
      "formId",
      "message",
      "config",
    ]);
  });
  it("records a permanent failure before ack and strips message content", async () => {
    const f = fixture(
      vi.fn(
        async () =>
          ({ status: "failed", code: "AUTHENTICATION_FAILED" }) as const,
      ),
    );
    const record = vi.fn(async (_event: FailureRecordV1) => {});
    const message = queueMessage(job("private email/address text"));
    await consumeQueue(
      f.config,
      { messages: [message] },
      { ...f, dependencies: {}, failureSink: { record } },
    );
    const failure = record.mock.calls[0]?.[0];
    expect(JSON.stringify(failure)).not.toContain("private");
    expect(failureEnvelopeSchema.safeParse(failure).success).toBe(true);
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      (message.ack as any).mock.invocationCallOrder[0],
    );
  });
  it("explicitly retries on failure-sink error to prevent successful-return auto-ack", async () => {
    const f = fixture();
    const message = queueMessage({
      version: 99,
      message: "sensitive",
      deliveryId: "unsafe@address",
    });
    await consumeQueue(
      f.config,
      { messages: [message] },
      {
        ...f,
        dependencies: {},
        failureSink: {
          record: async () => {
            throw new Error("secret upstream details");
          },
        },
      },
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.events)).not.toMatch(
      /sensitive|unsafe|secret upstream/,
    );
  });
  it("settles mixed batches independently including unexpected exceptions", async () => {
    const deliver = vi.fn(
      async (input: {
        message: { text: string };
      }): Promise<DeliveryOutcome> => {
        if (input.message.text === "throw") throw new Error("webhook secret");
        return input.message.text === "retry"
          ? { status: "retry", code: "RATE_LIMITED", retryAfterSeconds: 25 }
          : { status: "accepted" };
      },
    );
    const f = fixture(deliver);
    const messages = ["ok", "retry", "throw", "also-ok"].map((text) =>
      queueMessage(job(text)),
    );
    await consumeQueue(
      f.config,
      { messages },
      { ...f, dependencies: {}, failureSink: { record: vi.fn() } },
    );
    for (const index of [0, 3]) {
      expect(messages[index]?.ack).toHaveBeenCalledOnce();
      expect(messages[index]?.retry).not.toHaveBeenCalled();
    }
    for (const index of [1, 2]) {
      expect(messages[index]?.ack).not.toHaveBeenCalled();
      expect(messages[index]?.retry).toHaveBeenCalledOnce();
    }
    expect(messages[1]?.retry).toHaveBeenCalledWith({ delaySeconds: 25 });
    expect(deliver).toHaveBeenCalledTimes(4);
  });
  it("bounds thrown/hung providers with cancellation and a TIMEOUT outcome", async () => {
    const f = fixture(vi.fn(() => new Promise<never>(() => {})));
    const result = await dispatch(f.config, job(), 5, {
      ...f,
      dependencies: {},
      timeoutMs: 5,
    });
    expect(result.outcome).toEqual({ status: "retry", code: "TIMEOUT" });
    expect(f.deliver.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });
  it("rejects invalid envelopes, unknown versions, extra raw data and excessive bytes", async () => {
    const f = fixture();
    for (const body of [
      null,
      { ...job(), version: 2 },
      { ...job(), data: { apiKey: "secret" } },
      job("😀".repeat(5000)),
    ]) {
      const result = await dispatch(f.config, body, 1, {
        ...f,
        dependencies: {},
      });
      expect(result.outcome.status).toBe("failed");
      expect(JSON.stringify(result.failure)).not.toMatch(/secret|😀/);
    }
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("fails closed on unavailable secrets and invalid provider outcomes", async () => {
    const f = fixture();
    f.secretReader.read.mockImplementation(() => {
      throw new Error("credential missing");
    });
    expect(
      (await dispatch(f.config, job(), 1, { ...f, dependencies: {} })).outcome,
    ).toEqual({ status: "retry", code: "UNKNOWN" });
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("caps retry hints, attempts and jitter to positive integer budgets", () => {
    for (const attempt of [1, 3, 999])
      for (const hint of [-1, 0, 2.7, 1000000, Infinity]) {
        const delay = boundedBackoff(
          { status: "retry", code: "UNKNOWN", retryAfterSeconds: hint },
          attempt,
          () => 0.8,
        );
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(3600);
      }
  });
  it("validates failure records before publishing and bounds a hanging sink", async () => {
    const send = vi.fn(() => new Promise<never>(() => {}));
    await expect(
      cloudflareFailureSink({ send }, 5).record({
        kind: "failure.record",
        version: 1,
        occurredAt: new Date().toISOString(),
        code: "INVALID_PAYLOAD",
        source: "invalid_job",
      }),
    ).rejects.toThrow(/deadline/);
    expect(send).toHaveBeenCalledOnce();
    await expect(
      cloudflareFailureSink({ send }).record({ message: "secret" } as any),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
});
