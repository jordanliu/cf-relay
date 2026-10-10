import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { job } from "../contracts/fixtures";

it("local platform moves the original delivery job to DLQ after its retry budget", async () => {
  const built = await build({
    entryPoints: ["tests/platform/consumer.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    write: false,
  });
  const script = built.outputFiles[0]?.text;
  if (!script) throw new Error("Missing fixture bundle");
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "relay-test",
          compatibilityDate: "2026-10-10",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
          env: {
            SNAPSHOT: { type: "kv", id: "snapshot-test" },
            DELIVERIES: { type: "queue", name: "deliveries" },
          },
          triggers: [
            {
              type: "queue",
              name: "deliveries",
              maxRetries: 1,
              deadLetterQueue: "failures",
              maxBatchSize: 1,
              maxBatchTimeout: 0,
            },
            {
              type: "queue",
              name: "failures",
              maxBatchSize: 1,
              maxBatchTimeout: 0,
            },
          ],
        },
      },
    ],
    telemetry: { enabled: false },
  });
  try {
    const original = { ...job("original rendered content"), formId: "test" };
    const producer = await mf.getQueueProducer("DELIVERIES");
    await producer.send(original, { contentType: "json" });
    const snapshot = await mf.getKVNamespace("SNAPSHOT");
    await expect
      .poll(async () => snapshot.get("dlq", "json"), {
        timeout: 15000,
        interval: 200,
      })
      .toEqual(original);
  } finally {
    await mf.dispose();
  }
}, 30000);
