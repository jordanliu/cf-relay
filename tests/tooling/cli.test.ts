import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/tooling/cli";

const root = fileURLToPath(new URL("../../", import.meta.url));
const execute = promisify(execFile);
let directory: string;

async function cli(...args: string[]) {
  try {
    const result = await execute(
      process.execPath,
      [join(root, "scripts/relay.mjs"), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: join(root, ".scratch/wrangler-logs"),
        },
      },
    );
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as Error & {
      code: number;
      stdout: string;
      stderr: string;
    };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

beforeEach(async () => {
  await mkdir(join(root, ".scratch"), { recursive: true });
  directory = await mkdtemp(join(root, ".scratch/tooling-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("relay tooling commands", () => {
  it("uses root deployment configuration and safely migrates legacy credentials for the default Worker", async () => {
    await symlink(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      "junction",
    );
    vi.stubEnv("WRANGLER_SEND_METRICS", "false");
    vi.stubEnv("WRANGLER_LOG_PATH", join(directory, "wrangler-logs"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      await main(
        ["init", "--mode", "server", "--provider", "slack"],
        directory,
      ),
    ).toBe(0);
    const wrangler = JSON.parse(
      await readFile(join(directory, "wrangler.jsonc"), "utf8"),
    );
    expect(wrangler.main).toBe("apps/worker/src/index.ts");
    expect(await readFile(join(directory, ".dev.vars.example"), "utf8")).toBe(
      "SLACK_WEBHOOK_V1=\nSERVER_API_KEY=\n",
    );
    await expect(
      readFile(join(directory, "apps/worker/wrangler.jsonc")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const legacy = join(directory, "apps/worker/.dev.vars");
    const credentials =
      "SLACK_WEBHOOK_V1=private-test-only\nSERVER_API_KEY=private-test-only\n";
    await writeFile(legacy, credentials);
    expect(await main(["setup"], directory)).toBe(0);
    const local = join(directory, ".dev.vars");
    expect(await readFile(local, "utf8")).toBe(credentials);
    expect(await readFile(legacy, "utf8")).toBe(credentials);
    expect(
      await readFile(
        join(directory, "apps/worker/worker-configuration.d.ts"),
        "utf8",
      ),
    ).toContain("DELIVERIES: Queue");
    expect(await main(["doctor", "--local", "--strict"], directory)).toBe(0);

    const replacement = credentials.replaceAll(
      "private-test-only",
      "private-root-test-only",
    );
    await writeFile(local, replacement);
    expect(await main(["setup"], directory)).toBe(0);
    expect(await readFile(local, "utf8")).toBe(replacement);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
  }, 15_000);

  it.each([
    ["browser", "slack", "cloudflare"],
    ["server", "slack", "cloudflare"],
    ["browser", "discord", "cloudflare"],
    ["server", "discord", "cloudflare"],
    ["browser", "email", "cloudflare"],
    ["server", "email", "cloudflare"],
    ["browser", "email", "resend"],
    ["server", "email", "resend"],
  ])(
    "creates and previews a valid %s/%s/%s profile",
    async (mode, provider, transport) => {
      const created = await cli(
        "init",
        "--mode",
        mode,
        "--provider",
        provider,
        "--origin",
        "https://forms.acme.io",
        "--from",
        "forms@acme.io",
        "--to",
        "team@acme.io",
        "--output",
        directory,
        ...(provider === "email" ? ["--email-transport", transport] : []),
      );
      expect(created.code, created.stderr).toBe(0);
      const config = join(directory, "relay.config.ts");
      const checked = await cli(
        "doctor",
        "--config",
        config,
        "--strict",
        "--json",
      );
      expect(checked.code, `${checked.stdout}${checked.stderr}`).toBe(0);
      const wrangler = JSON.parse(
        await readFile(join(directory, "wrangler.jsonc"), "utf8"),
      );
      expect(Boolean(wrangler.send_email)).toBe(
        provider === "email" && transport === "cloudflare",
      );
      expect(Boolean(wrangler.ratelimits)).toBe(mode === "browser");
      expect(wrangler.assets).toBeUndefined();
      const rendered = await cli(
        "preview",
        "--config",
        config,
        "--input",
        join(directory, "fixture.json"),
      );
      expect(rendered.code, rendered.stderr).toBe(0);
      expect(JSON.parse(rendered.stdout).previews[0].provider).toBe(provider);
    },
  );

  it.each([
    ["server", "slack"],
    ["browser", "email"],
  ])(
    "prepares a %s/%s API with generated bindings and preserves credentials on repeat setup",
    async (mode, provider) => {
      await cli(
        "init",
        "--mode",
        mode,
        "--provider",
        provider,
        "--origin",
        "https://forms.acme.io",
        "--from",
        "forms@acme.io",
        "--to",
        "team@acme.io",
        "--output",
        directory,
        ...(provider === "email" ? ["--email-transport", "resend"] : []),
      );
      const config = join(directory, "relay.config.ts");
      const original = await readFile(config, "utf8");
      const prepared = await cli("setup", "--config", config);
      expect(prepared.code, prepared.stderr).toBe(0);
      expect(prepared.stdout).toContain("Preview passed:");
      expect(await readFile(config, "utf8")).toBe(original);
      const bindings = await readFile(
        join(directory, "worker-configuration.d.ts"),
        "utf8",
      );
      expect(bindings).toContain("DELIVERIES: Queue");
      expect(bindings).not.toContain("EMAIL: SendEmail");
      expect(bindings.includes("FORM_RATE_LIMIT: RateLimit")).toBe(
        mode === "browser",
      );
      const local = join(directory, ".dev.vars");
      const content = await readFile(local, "utf8");
      if (mode === "server") {
        const key = content.match(/^SERVER_API_KEY=(.+)$/m)?.[1];
        expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(`${prepared.stdout}${prepared.stderr}`).not.toContain(key);
      } else {
        expect(content).toBe("RESEND_API_KEY=\nTURNSTILE_SECRET=\n");
      }
      if (process.platform !== "win32")
        expect((await stat(local)).mode & 0o777).toBe(0o600);
      const credentials = `${content}EXISTING_SECRET=private-test-only\n`;
      await writeFile(local, credentials);
      const repeated = await cli("setup", "--config", config);
      expect(repeated.code, repeated.stderr).toBe(0);
      expect(repeated.stdout).toContain("Preserved");
      expect(await readFile(local, "utf8")).toBe(credentials);
      expect(`${repeated.stdout}${repeated.stderr}`).not.toContain(
        "private-test-only",
      );
    },
    15_000,
  );

  it("stops setup before creating credentials or bindings when the fixture is invalid", async () => {
    await cli(
      "init",
      "--mode",
      "server",
      "--provider",
      "slack",
      "--output",
      directory,
    );
    await writeFile(
      join(directory, "fixture.json"),
      JSON.stringify({ event: "private-test-only" }),
    );
    const rejected = await cli(
      "setup",
      "--config",
      join(directory, "relay.config.ts"),
    );
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("form schema");
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(
      "private-test-only",
    );
    for (const file of [".dev.vars", "worker-configuration.d.ts"])
      await expect(readFile(join(directory, file))).rejects.toMatchObject({
        code: "ENOENT",
      });
  });

  it("stops setup on configuration warnings before creating local files", async () => {
    await cli(
      "init",
      "--mode",
      "browser",
      "--provider",
      "slack",
      "--output",
      directory,
    );
    const rejected = await cli(
      "setup",
      "--config",
      join(directory, "relay.config.ts"),
    );
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("PLACEHOLDER");
    await expect(readFile(join(directory, ".dev.vars"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates a server starter requiring only Slack and API-key credentials", async () => {
    const result = await cli(
      "init",
      "--mode",
      "server",
      "--provider",
      "slack",
      "--output",
      directory,
    );
    expect(result.code, result.stderr).toBe(0);
    const wrangler = JSON.parse(
      await readFile(join(directory, "wrangler.jsonc"), "utf8"),
    );
    expect(wrangler.send_email).toBeUndefined();
    expect(wrangler.ratelimits).toBeUndefined();
    expect(await readFile(join(directory, ".dev.vars.example"), "utf8")).toBe(
      "SLACK_WEBHOOK_V1=\nSERVER_API_KEY=\n",
    );
    expect(await readFile(join(directory, "fixture.json"), "utf8")).toContain(
      '"event": "Example event"',
    );
  });

  it("refuses to overwrite configuration and preserves local credentials even with --force", async () => {
    const args = [
      "init",
      "--mode",
      "server",
      "--provider",
      "slack",
      "--output",
      directory,
    ];
    expect((await cli(...args)).code).toBe(0);
    await writeFile(
      join(directory, ".dev.vars"),
      "SERVER_API_KEY=private-test-only\n",
    );
    const refused = await cli(...args);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--force");
    expect((await cli(...args, "--force")).code).toBe(0);
    expect(await readFile(join(directory, ".dev.vars"), "utf8")).toBe(
      "SERVER_API_KEY=private-test-only\n",
    );
  });

  it("reports missing local credentials by name without exposing configured values", async () => {
    await cli(
      "init",
      "--mode",
      "server",
      "--provider",
      "slack",
      "--output",
      directory,
    );
    await writeFile(
      join(directory, ".dev.vars"),
      "SLACK_WEBHOOK_V1=private-webhook-test-only\n",
    );
    const result = await cli(
      "doctor",
      "--config",
      join(directory, "relay.config.ts"),
      "--local",
      "--json",
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.forms).toEqual([
      {
        id: "events",
        destinations: ["primary"],
        requiredSecrets: ["SERVER_API_KEY", "SLACK_WEBHOOK_V1"],
        requiredBindings: [],
      },
    ]);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "LOCAL_SECRET_MISSING",
        formId: "events",
        message: expect.stringContaining("SERVER_API_KEY"),
      }),
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "private-webhook-test-only",
    );
  });

  it("detects mismatched Queue configuration and a missing browser rate-limit binding", async () => {
    await cli(
      "init",
      "--mode",
      "browser",
      "--provider",
      "discord",
      "--origin",
      "https://forms.acme.io",
      "--output",
      directory,
    );
    const path = join(directory, "wrangler.jsonc");
    const wrangler = JSON.parse(await readFile(path, "utf8"));
    wrangler.queues.consumers[0].dead_letter_queue = "wrong-failure-queue";
    delete wrangler.ratelimits;
    await writeFile(
      path,
      `// Comments and trailing commas are accepted.\n${JSON.stringify(wrangler).replace(/}$/, ",}")}`,
    );
    const result = await cli(
      "doctor",
      "--config",
      join(directory, "relay.config.ts"),
      "--json",
    );
    expect(result.code, result.stderr).toBe(1);
    expect(
      JSON.parse(result.stdout).diagnostics.map(
        (item: { code: string }) => item.code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "QUEUE_CONSUMER_MISMATCH",
        "GUARD_BINDING_MISSING",
      ]),
    );
  });

  it("detects missing native email capabilities and mismatched sender allowlists", async () => {
    await cli(
      "init",
      "--mode",
      "server",
      "--provider",
      "email",
      "--from",
      "forms@acme.io",
      "--to",
      "team@acme.io",
      "--output",
      directory,
    );
    const path = join(directory, "wrangler.jsonc");
    const wrangler = JSON.parse(await readFile(path, "utf8"));
    wrangler.send_email[0].allowed_sender_addresses = ["other@acme.io"];
    await writeFile(path, JSON.stringify(wrangler));
    const args = [
      "doctor",
      "--config",
      join(directory, "relay.config.ts"),
      "--json",
    ];
    const mismatch = await cli(...args);
    expect(mismatch.code).toBe(1);
    expect(JSON.parse(mismatch.stdout).diagnostics).toContainEqual(
      expect.objectContaining({ code: "EMAIL_ALLOWLIST_MISMATCH" }),
    );
    delete wrangler.send_email;
    await writeFile(path, JSON.stringify(wrangler));
    const missing = await cli(...args);
    expect(missing.code).toBe(1);
    const report = JSON.parse(missing.stdout);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "EMAIL_BINDING_MISSING" }),
    );
    expect(report.forms[0].requiredSecrets).not.toContain("EMAIL");
    expect(report.forms[0].requiredBindings).toContain("EMAIL");
  });

  it("previews rendered notifications without requiring or exposing credentials", async () => {
    await cli(
      "init",
      "--mode",
      "browser",
      "--provider",
      "slack",
      "--origin",
      "https://forms.acme.io",
      "--output",
      directory,
    );
    await writeFile(
      join(directory, ".dev.vars"),
      "SLACK_WEBHOOK_V1=private-webhook-test-only\n",
    );
    const result = await cli(
      "preview",
      "--config",
      join(directory, "relay.config.ts"),
      "--input",
      join(directory, "fixture.json"),
    );
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.formId).toBe("contact");
    expect(report.previews[0].payload.blocks[1].text.text).toBe(
      "A local preview submission.",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "private-webhook-test-only",
    );
    expect(report.errors).toEqual([]);
  });

  it("rejects invalid fixtures without echoing their values and removes guard fields before schema validation", async () => {
    await cli(
      "init",
      "--mode",
      "browser",
      "--provider",
      "slack",
      "--output",
      directory,
    );
    const config = join(directory, "relay.config.ts");
    const input = join(directory, "fixture.json");
    const fixture = JSON.parse(await readFile(input, "utf8"));
    fixture["cf-turnstile-response"] = "private-token-test-only";
    fixture.website = "";
    await writeFile(input, JSON.stringify(fixture));
    expect(
      (await cli("preview", "--config", config, "--input", input)).code,
    ).toBe(0);
    fixture.email = "invalid-private-test-only";
    await writeFile(input, JSON.stringify(fixture));
    const invalid = await cli("preview", "--config", config, "--input", input);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("form schema");
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(
      "private-test-only",
    );
    await writeFile(
      input,
      JSON.stringify({ ...fixture, message: "a".repeat(32768) }),
    );
    const oversized = await cli(
      "preview",
      "--config",
      config,
      "--input",
      input,
    );
    expect(oversized.code).toBe(1);
    expect(oversized.stderr).toContain("32 KiB");
  });

  it("reports renderer limits and writes escaped HTML without overwriting existing previews", async () => {
    await cli(
      "init",
      "--mode",
      "server",
      "--provider",
      "email",
      "--output",
      directory,
    );
    const config = join(directory, "relay.config.ts");
    const input = join(directory, "fixture.json");
    await writeFile(
      input,
      JSON.stringify({ event: "Unsafe\nsubject", details: "Text" }),
    );
    const rejected = await cli("preview", "--config", config, "--input", input);
    expect(rejected.code).toBe(1);
    expect(JSON.parse(rejected.stdout).errors[0].code).toBe("INVALID_PAYLOAD");
    await writeFile(
      input,
      JSON.stringify({
        event: "Preview",
        details: '<script>alert("unsafe")</script>',
      }),
    );
    const output = join(directory, "preview.html");
    const args = [
      "preview",
      "--config",
      config,
      "--input",
      input,
      "--output",
      output,
    ];
    expect((await cli(...args)).code).toBe(0);
    const html = await readFile(output, "utf8");
    expect(html).toContain("sandbox srcdoc=");
    expect(html).not.toContain("<script>");
    expect((await cli(...args)).code).toBe(1);
    expect((await cli(...args, "--force")).code).toBe(0);
  });
});
