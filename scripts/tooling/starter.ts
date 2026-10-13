import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { ToolError } from "./errors";

async function formatSource(
  root: string,
  file: string,
  content: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        join(root, "node_modules/@biomejs/biome/bin/biome"),
        "check",
        "--write",
        "--stdin-file-path",
        file,
      ],
      { cwd: root },
      (error, stdout) => {
        if (error)
          reject(
            new ToolError(
              "Cannot format the starter. Run npm ci and check the selected options.",
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.end(content);
  });
}

type Options = {
  mode?: string | undefined;
  provider?: string | undefined;
  "email-transport"?: string | undefined;
  origin?: string | undefined;
  name?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  output?: string | undefined;
  force?: boolean | undefined;
};

export async function createStarter(
  root: string,
  options: Options,
): Promise<void> {
  if (options.mode !== "browser" && options.mode !== "server")
    throw new ToolError("Choose --mode browser or --mode server.");
  if (!["slack", "discord", "email"].includes(options.provider ?? ""))
    throw new ToolError("Choose --provider slack, discord, or email.");
  const mode = options.mode;
  const provider = options.provider as "slack" | "discord" | "email";
  const transport = options["email-transport"] ?? "cloudflare";
  if (!["cloudflare", "resend"].includes(transport))
    throw new ToolError("Choose --email-transport cloudflare or resend.");
  if (options["email-transport"] && provider !== "email")
    throw new ToolError(
      "--email-transport applies only to the email provider.",
    );
  const name = options.name ?? "cf-relay";
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name))
    throw new ToolError(
      "Worker names must start with a lowercase letter and use letters, numbers, or hyphens (maximum 63 characters).",
    );
  let origin: URL;
  try {
    origin = new URL(options.origin ?? "https://example.com");
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== (options.origin ?? "https://example.com")
    )
      throw new Error();
  } catch {
    throw new ToolError(
      "--origin must be an exact HTTP(S) origin without a path.",
    );
  }
  const from = options.from ?? "forms@example.com";
  const to = (options.to ?? "team@example.com")
    .split(",")
    .map((value) => value.trim());
  if (
    provider === "email" &&
    (!z.email().safeParse(from).success ||
      !z.array(z.email()).min(1).max(50).safeParse(to).success)
  )
    throw new ToolError("Supply valid email addresses with --from and --to.");
  const output = resolve(root, options.output ?? "apps/worker");
  const browser = mode === "browser";
  const formId = browser ? "contact" : "events";
  const webhookSecret =
    provider === "slack" ? "SLACK_WEBHOOK_V1" : "DISCORD_WEBHOOK_V1";
  const secrets = [
    ...(provider === "email"
      ? transport === "resend"
        ? ["RESEND_API_KEY"]
        : []
      : [webhookSecret]),
    browser ? "TURNSTILE_SECRET" : "SERVER_API_KEY",
  ];
  const q = JSON.stringify;
  const guardImports = browser ? "honeypot, rateLimit, turnstile" : "apiKey";
  const config = `import { defineDestinations, defineForm, defineForms, defineProviders, defineRelay, secret } from "@cf-relay/core";
import { ${guardImports} } from "@cf-relay/policies";
import { ${provider}Provider } from "@cf-relay/provider-${provider}";
import { z } from "zod";

const providers = defineProviders([${provider}Provider()] as const);
const destinations = defineDestinations(providers, {
  primary: {
    provider: ${q(provider)},
    revision: "v1",
    ${provider === "email" ? `from: ${q(from)},\n    to: ${q(to)},` : `webhook: secret(${q(webhookSecret)}),`}
  },
});
const forms = defineForms(destinations, {
  ${formId}: defineForm({
    schema: z.object({
      ${browser ? "name: z.string().min(1).max(80),\n      email: z.email(),\n      message: z.string().min(1).max(5000)," : "event: z.string().min(1).max(80),\n      details: z.string().min(1).max(5000),"}
    }).strict(),
    ${browser ? `allowedOrigins: [${q(origin.origin)}],\n    ` : ""}guards: [
      ${browser ? `rateLimit({ binding: "FORM_RATE_LIMIT" }),\n      turnstile({ tokenField: "cf-turnstile-response", secret: secret("TURNSTILE_SECRET"), expectedHostname: ${q(origin.hostname)}, expectedAction: "contact" }),\n      honeypot({ field: "website" }),` : 'apiKey({ secret: secret("SERVER_API_KEY") }),'}
    ],
    destinations: ["primary"],
    message: ({ data }) => (${browser ? '{ title: "New contact submission", text: data.message, fields: { Name: data.name }, replyTo: data.email }' : "{ title: data.event, text: data.details }"}),
  }),
});
export default defineRelay({ providers, destinations, forms });
`;
  const emailImport =
    provider === "email"
      ? `import { ${transport === "resend" ? "resend" : "cloudflare"}EmailTransport } from "@cf-relay/email-${transport}";\n`
      : "";
  const entry = `${emailImport}import { createCloudflareRelay } from "@cf-relay/runtime-cloudflare";
import config from "../relay.config";

export type WorkerEnv = WorkerBindings & {
${secrets.map((secret) => `  ${secret}: string;`).join("\n")}
};
const relay = createCloudflareRelay(config, {
  providerDependencies: {${provider === "email" ? `\n    email: (env: WorkerEnv) => ({ transport: ${transport === "resend" ? "resendEmailTransport(env.RESEND_API_KEY)" : "cloudflareEmailTransport(env.EMAIL)"} }),\n  ` : ""}},
});
export default {
  fetch: (request: Request, env: WorkerEnv, ctx: ExecutionContext) => relay.handleRequest(request, env, ctx),
  queue: (batch, env, ctx) => relay.handleQueue(batch, env, ctx),
} satisfies ExportedHandler<WorkerEnv>;
`;
  const wrangler = {
    $schema: relative(
      output,
      join(root, "node_modules/wrangler/config-schema.json"),
    ),
    name,
    main: "src/index.ts",
    compatibility_date: "2026-10-10",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true, head_sampling_rate: 1 },
    queues: {
      producers: [
        { binding: "DELIVERIES", queue: `${name}-deliveries` },
        { binding: "FAILURES", queue: `${name}-failures` },
      ],
      consumers: [
        {
          queue: `${name}-deliveries`,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 5,
          dead_letter_queue: `${name}-failures`,
          max_concurrency: 10,
        },
      ],
    },
    ...(provider === "email" && transport === "cloudflare"
      ? {
          send_email: [
            {
              name: "EMAIL",
              allowed_sender_addresses: [from],
              allowed_destination_addresses: to,
            },
          ],
        }
      : {}),
    ...(browser
      ? {
          ratelimits: [
            {
              name: "FORM_RATE_LIMIT",
              namespace_id: String(randomInt(1, 2147483647)),
              simple: { limit: 20, period: 60 },
            },
          ],
        }
      : {}),
  };
  const files: Record<string, string> = {
    "relay.config.ts": config,
    "wrangler.jsonc": `${JSON.stringify(wrangler, null, 2)}\n`,
    "src/index.ts": entry,
    ".dev.vars.example": `${secrets.map((secret) => `${secret}=`).join("\n")}\n`,
    "fixture.json": `${JSON.stringify(browser ? { name: "Example sender", email: "sender@example.com", message: "A local preview submission." } : { event: "Example event", details: "A local preview submission." }, null, 2)}\n`,
  };
  for (const file of Object.keys(files)) {
    try {
      await access(join(output, file));
    } catch {
      continue;
    }
    if (!options.force)
      throw new ToolError(
        "Starter files already exist. Choose another --output directory or use --force to replace configuration files.",
      );
  }
  for (const [file, content] of Object.entries(files)) {
    if (/\.(ts|jsonc?|html)$/.test(file))
      files[file] = await formatSource(root, file, content);
  }
  for (const [file, content] of Object.entries(files)) {
    const path = join(output, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: options.force ? "w" : "wx" });
  }
  console.log(
    `Created ${mode}/${provider} starter in ${relative(root, output) || "."}.`,
  );
  console.log(
    `Generate bindings: npx wrangler types --config ${JSON.stringify(relative(root, join(output, "wrangler.jsonc")))} ${JSON.stringify(relative(root, join(output, "worker-configuration.d.ts")))} --env-interface WorkerBindings --include-runtime false`,
  );
  console.log(
    "Set the required secrets, then follow docs/operations.md to provision and deploy.",
  );
}
