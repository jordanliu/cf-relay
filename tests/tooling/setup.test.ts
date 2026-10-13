import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createCloudflareRelay } from "@cf-relay/runtime-cloudflare";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/tooling/cli";
import { diagnose } from "../../scripts/tooling/doctor";
import { readProject } from "../../scripts/tooling/project";
import type { Prompts } from "../../scripts/tooling/prompts";
import { setupProject } from "../../scripts/tooling/setup";
import { executionContext } from "../contracts/fixtures";

const root = fileURLToPath(new URL("../../", import.meta.url));
let directory: string;
beforeEach(async () => {
  await mkdir(join(root, ".scratch"), { recursive: true });
  directory = await mkdtemp(join(root, ".scratch/setup-"));
  await symlink(
    join(root, "node_modules"),
    join(directory, "node_modules"),
    "junction",
  );
  vi.stubEnv("WRANGLER_SEND_METRICS", "false");
  vi.stubEnv("RELAY_API_KEY", undefined);
  vi.stubEnv("WRANGLER_LOG_PATH", join(directory, "wrangler-logs"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function init(providers = "slack", extra: string[] = []) {
  expect(
    await main(
      ["init", "--mode", "server", "--providers", providers, ...extra],
      directory,
    ),
  ).toBe(0);
}
function prompts(secret = "private-test-only") {
  return {
    ask: vi.fn(async (_label: string, fallback?: string) => fallback ?? ""),
    secret: vi.fn(async () => secret),
    close: vi.fn(),
  } satisfies Prompts;
}

describe("selected destinations and guided setup", () => {
  it.each(["email", "slack,discord", "webhook", "slack,discord,email,webhook"])(
    "generates %s with only selected requirements and one job per destination",
    async (providers) => {
      await init(
        providers,
        providers.includes("email")
          ? ["--from", "forms@acme.io", "--to", "team@acme.io"]
          : [],
      );
      const project = await readProject(directory);
      const report = await setupProject(directory, {});
      const parsed = ts.readConfigFile(
        join(root, "tsconfig.json"),
        ts.sys.readFile,
      );
      const { options } = ts.parseJsonConfigFileContent(
        parsed.config,
        ts.sys,
        root,
      );
      const program = ts.createProgram(
        [
          join(directory, "apps/worker/src/index.ts"),
          join(directory, "apps/worker/worker-configuration.d.ts"),
        ],
        options,
      );
      expect(
        ts
          .getPreEmitDiagnostics(program)
          .map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          ),
      ).toEqual([]);
      const selected = providers.split(",");
      expect(
        Object.values(project.config.destinations).map(
          (value) => value.provider,
        ),
      ).toEqual(selected);
      expect(
        parseEnv(await readFile(join(directory, ".dev.vars.example"), "utf8")),
      ).toEqual({ SERVER_API_KEY: "" });
      expect(Boolean(project.wrangler.send_email)).toBe(
        selected.includes("email"),
      );
      expect(report.requiredSecrets.includes("SLACK_WEBHOOK_V1")).toBe(
        selected.includes("slack"),
      );
      expect(report.requiredSecrets.includes("DISCORD_WEBHOOK_V1")).toBe(
        selected.includes("discord"),
      );
      expect(report.requiredSecrets.includes("RESEND_API_KEY")).toBe(false);
      const local = parseEnv(
        await readFile(join(directory, ".dev.vars"), "utf8"),
      );
      if (selected.includes("webhook"))
        expect(local.WEBHOOK_SIGNING_SECRET_V1).toMatch(/^whsec_/);
      const sendBatch = vi.fn(async (_jobs: readonly unknown[]) => {});
      const relay = createCloudflareRelay(project.config, {
        providerDependencies: {
          email: () => ({ transport: { send: vi.fn() } }),
        },
      });
      const bindings = {
        ...Object.fromEntries(
          report.requiredSecrets.map((name) => [name, "fake-test-only"]),
        ),
        DELIVERIES: { sendBatch },
        FAILURES: { send: vi.fn() },
      };
      const request = () =>
        new Request("https://relay.example/v1/forms/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fake-test-only",
          },
          body: JSON.stringify({ event: "test", details: "offline" }),
        });
      const ctx = executionContext();
      const response = await relay.handleRequest(request(), bindings, ctx);
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        destinations: selected.length,
      });
      expect(sendBatch.mock.calls[0]?.[0]).toHaveLength(selected.length);
      const first = report.requiredSecrets.find(
        (name) => name !== "SERVER_API_KEY",
      );
      if (first) {
        sendBatch.mockClear();
        Reflect.deleteProperty(bindings, first);
        expect(
          (await relay.handleRequest(request(), bindings, ctx)).status,
        ).toBe(503);
        expect(sendBatch).not.toHaveBeenCalled();
      }
    },
    30_000,
  );

  it("changes routing while preserving other forms, guards, Queue names, and old destinations", async () => {
    await init();
    const configPath = join(directory, "apps/worker/relay.config.ts");
    let source = await readFile(configPath, "utf8");
    source = source.replace(
      "const forms = defineForms(destinations, {",
      `const forms = defineForms(destinations, {
      audit: defineForm({ schema: z.object({ counter: z.number() }), allowedOrigins: ["https://example.com"], guards: [apiKey({ secret: secret("SERVER_API_KEY") })], destinations: ["slack"], message: ({ data }) => ({ text: String(data.counter) }) }),`,
    );
    await writeFile(configPath, source);
    const original = await readProject(directory);
    await writeFile(
      join(directory, ".dev.vars"),
      "# Keep this comment\nSERVER_API_KEY=private-existing-key\nSLACK_WEBHOOK_V1=private-old-webhook\n",
    );
    const report = await setupProject(directory, {
      providers: "email",
      form: "events",
      from: "forms@acme.io",
      to: "team@acme.io",
    });
    const updated = await readProject(directory);
    expect(updated.config.forms.audit?.destinations).toEqual(["slack"]);
    expect(updated.config.forms.audit?.allowedOrigins).toEqual(
      original.config.forms.audit?.allowedOrigins,
    );
    expect(updated.config.forms.events?.destinations).toEqual(["events_email"]);
    expect(updated.config.destinations.slack).toEqual(
      original.config.destinations.slack,
    );
    expect(
      updated.config.forms.events?.schema.parse({
        event: "same",
        details: "same",
      }),
    ).toEqual({ event: "same", details: "same" });
    expect(
      updated.config.forms.events?.guards?.map((guard) => guard.type),
    ).toEqual(original.config.forms.events?.guards?.map((guard) => guard.type));
    expect(updated.wrangler.queues).toEqual(original.wrangler.queues);
    expect(updated.wrangler.name).toBe(original.wrangler.name);
    expect(report.requiredSecrets).toEqual(["SERVER_API_KEY"]);
    expect(await readFile(join(directory, ".dev.vars"), "utf8")).toBe(
      "# Keep this comment\nSERVER_API_KEY=private-existing-key\nSLACK_WEBHOOK_V1=private-old-webhook\n",
    );
  }, 15_000);

  it("previews configuration changes without writing configuration, bindings, or credentials", async () => {
    await init();
    const before = await readFile(
      join(directory, "apps/worker/relay.config.ts"),
      "utf8",
    );
    expect(
      await main(
        ["setup", "--providers", "slack,discord,webhook", "--dry-run"],
        directory,
      ),
    ).toBe(0);
    expect(
      await readFile(join(directory, "apps/worker/relay.config.ts"), "utf8"),
    ).toBe(before);
    await expect(readFile(join(directory, ".dev.vars"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(directory, "apps/worker/worker-configuration.d.ts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain(
      "events_discord",
    );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain(
      "WEBHOOK_SIGNING_SECRET_V1",
    );
  });

  it("rejects computed declarations and invalid selections before writing", async () => {
    await init();
    const path = join(directory, "apps/worker/relay.config.ts");
    const source = (await readFile(path, "utf8")).replace(
      'destinations: ["slack"]',
      "destinations: Object.keys(destinations)",
    );
    await writeFile(path, source);
    const beforeEntry = await readFile(
      join(directory, "apps/worker/src/index.ts"),
      "utf8",
    );
    await expect(
      setupProject(directory, { providers: "discord" }),
    ).rejects.toThrow(/static/);
    expect(await readFile(path, "utf8")).toBe(source);
    expect(
      await readFile(join(directory, "apps/worker/src/index.ts"), "utf8"),
    ).toBe(beforeEntry);
    await expect(
      setupProject(directory, { providers: "slack", provider: "discord" }),
    ).rejects.toThrow(/either/);
    await expect(setupProject(directory, { providers: "" })).rejects.toThrow(
      /one or more/,
    );
    await expect(
      setupProject(directory, { providers: "slack,slack" }),
    ).rejects.toThrow(/distinct/);
    await expect(
      setupProject(directory, { provider: "slack,discord" }),
    ).rejects.toThrow(/--providers/);
  });

  it("prompts only for missing selected credentials and preserves comments and existing values", async () => {
    await init();
    const path = join(directory, ".dev.vars");
    await writeFile(
      path,
      "# retained\nSERVER_API_KEY=private-api\nSLACK_WEBHOOK_V1=private-slack\nDISCORD_WEBHOOK_V1= # fill later\n",
    );
    const ui = prompts("private-discord");
    const report = await setupProject(
      directory,
      { providers: "slack,discord" },
      ui,
    );
    expect(ui.secret).toHaveBeenCalledExactlyOnceWith("DISCORD_WEBHOOK_V1");
    expect(report.missingSecrets).toEqual([]);
    const content = await readFile(path, "utf8");
    expect(content).toContain(
      "# retained\nSERVER_API_KEY=private-api\nSLACK_WEBHOOK_V1=private-slack\n",
    );
    expect(content).toContain("# fill later");
    expect(parseEnv(content).DISCORD_WEBHOOK_V1).toBe("private-discord");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      "private-",
    );
  }, 15_000);

  it("cancellation before credential entry leaves configuration and local files unchanged", async () => {
    await init();
    const path = join(directory, "apps/worker/relay.config.ts");
    const before = await readFile(path, "utf8");
    const ui = prompts();
    ui.secret.mockRejectedValue(new Error("canceled"));
    await expect(
      setupProject(directory, { providers: "discord" }, ui),
    ).rejects.toThrow("canceled");
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(readFile(join(directory, ".dev.vars"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("sets up Resend email alone without unrelated bindings or credentials", async () => {
    await init("email", [
      "--email-transport",
      "resend",
      "--from",
      "forms@acme.io",
      "--to",
      "team@acme.io",
    ]);
    const report = await setupProject(directory, {});
    expect(report.requiredSecrets).toEqual([
      "RESEND_API_KEY",
      "SERVER_API_KEY",
    ]);
    expect(report.missingSecrets).toEqual(["RESEND_API_KEY"]);
    expect((await readProject(directory)).wrangler.send_email).toBeUndefined();
  }, 15_000);
  it("generates distinct signing keys for destinations whose form names normalize alike", async () => {
    await init("slack,webhook");
    const path = join(directory, "apps/worker/relay.config.ts");
    const form = (name: string) =>
      `${JSON.stringify(name)}: defineForm({ schema: z.object({ event: z.string(), details: z.string() }), guards: [apiKey({ secret: secret("SERVER_API_KEY") })], destinations: ["slack"], message: ({ data }) => ({ text: data.event }) }),`;
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        "const forms = defineForms(destinations, {",
        `const forms = defineForms(destinations, { ${["1", "a-b", "a_b"].map(form).join("\n")}`,
      ),
    );
    const signingNames: string[] = [];
    for (const formId of ["1", "a-b", "a_b"]) {
      const result = await setupProject(directory, {
        providers: "webhook",
        form: formId,
      });
      const name = result.requiredSecrets.find((name) =>
        name.endsWith("SIGNING_SECRET_V1"),
      );
      expect(name).toMatch(/^DEST_[A-Z0-9_]+_WEBHOOK_SIGNING_SECRET_V1$/);
      if (name) signingNames.push(name);
    }
    const values = parseEnv(
      await readFile(join(directory, ".dev.vars"), "utf8"),
    );
    expect(new Set(signingNames).size).toBe(3);
    expect(new Set(signingNames.map((name) => values[name])).size).toBe(3);
    const report = await diagnose(await readProject(directory), false, "a_b");
    expect(report.forms.map((form) => form.id)).toEqual(["a_b"]);
    expect(report.forms[0]?.requiredSecrets).not.toContain("SLACK_WEBHOOK_V1");
  }, 30_000);
});
