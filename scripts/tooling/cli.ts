import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { HttpClient } from "@cf-relay/core";
import { diagnose } from "./doctor";
import { ToolError } from "./errors";
import { preview, previewHtml } from "./preview";
import { readProject, writeOutput } from "./project";
import { type Prompts, TerminalPrompts } from "./prompts";
import { selectedProviders } from "./providers";
import { remoteDoctor, sendTest } from "./remote";
import { setupProject } from "./setup";
import { createStarter } from "./starter";

const help = `Usage: npm run <command> -- [options]

setup    Select destinations, validate configuration, generate bindings, and prepare credentials.
         --providers slack,discord,email,webhook --form formId --dry-run
         --email-transport cloudflare|resend|smtp --from sender --to recipients
         --webhook-auth signing|bearer|both|none (default: signing)
         --config path (default: apps/worker/relay.config.ts)
         --input path (default: fixture.json beside configuration)
         --form formId (optional for a single-form config) --origin https://client-domain
         Existing credentials are preserved; a new server API key is generated locally.

init     Generate a single-form Worker with selected destinations.
         --mode browser|server --providers slack,discord,email,webhook
         --provider remains available for a single provider; do not combine both flags.
         --email-transport cloudflare|resend|smtp --origin https://your-domain
         --name worker-name --from sender --to recipient[,recipient]
         --output directory (default: apps/worker) --force --dry-run
         --webhook-auth signing|bearer|both|none

Existing starter files require --force. Existing credential values are preserved.

doctor   Inspect configuration and required credentials without sending.
         --config path (default: apps/worker/relay.config.ts)
         --local (check .dev.vars) --strict (fail on warnings) --json
         --endpoint URL --form formId (authenticated remote readiness)

send     Preview a fixture; --live checks readiness and submits once.
         --endpoint URL --form formId --input path --origin exact-origin --live
         Use RELAY_API_KEY or local SERVER_API_KEY, never a credential argument.

preview  Validate a fixture and render notifications without delivery.
         --input path --form formId (optional for a single-form config)
         --config path --origin https://client-domain
         --output path (.html for a page, otherwise JSON) --force
`;

export async function main(
  args: string[],
  root: string,
  environment: {
    prompts?: Prompts;
    interactive?: boolean;
    http?: HttpClient;
  } = {},
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean" },
        mode: { type: "string" },
        provider: { type: "string" },
        providers: { type: "string" },
        "webhook-auth": { type: "string" },
        "dry-run": { type: "boolean" },
        endpoint: { type: "string" },
        live: { type: "boolean" },
        "email-transport": { type: "string" },
        origin: { type: "string" },
        name: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        output: { type: "string" },
        force: { type: "boolean" },
        config: { type: "string" },
        local: { type: "boolean" },
        strict: { type: "boolean" },
        json: { type: "boolean" },
        input: { type: "string" },
        form: { type: "string" },
      },
    });
    if (values.help || positionals.length === 0) {
      console.log(help);
      return 0;
    }
    if (positionals.length !== 1)
      throw new ToolError(
        "Unknown command. Use --help for available commands.",
      );
    const interactive =
      environment.interactive ??
      Boolean(
        environment.prompts || (process.stdin.isTTY && process.stdout.isTTY),
      );
    if (
      ["init", "setup"].includes(positionals[0] ?? "") &&
      values.provider !== undefined &&
      values.providers !== undefined
    )
      selectedProviders(values);
    if (positionals[0] === "setup") {
      const prompts =
        interactive && !values["dry-run"]
          ? (environment.prompts ?? new TerminalPrompts())
          : undefined;
      let report: Awaited<ReturnType<typeof setupProject>>;
      try {
        report = await setupProject(root, values, prompts);
      } finally {
        prompts?.close();
      }
      if (report.dryRun) {
        console.log(
          `Would configure ${report.formId}: ${report.routes.join(", ")}.`,
        );
        for (const addition of report.additions)
          console.log(`Add ${addition.id} (${addition.provider}).`);
        for (const path of report.changes) console.log(`Update ${path}.`);
        console.log(
          `Required secrets: ${report.requiredSecrets.join(", ") || "none"}.`,
        );
        return 0;
      }
      console.log("Configuration checked and Worker bindings generated.");
      console.log(
        `Preview passed: ${report.formId}, ${report.destinations} destination(s).`,
      );
      console.log(
        `${report.created ? (report.migrated ? "Copied existing credentials to" : "Created") : "Preserved"} ${report.credentials}.`,
      );
      console.log(
        `Required secrets: ${report.requiredSecrets.join(", ") || "none"}.`,
      );
      if (report.missingSecrets.length)
        console.log(
          `Missing local credentials: ${report.missingSecrets.join(", ")}.`,
        );
      console.log(
        "Follow docs/operations.md to provision and deploy. Run doctor --local --strict before uploading credentials. No resources were created or notifications sent.",
      );
      return 0;
    }
    if (positionals[0] === "send") {
      const report = await sendTest(
        await readProject(root, values.config),
        {
          ...values,
          input: values.input ? resolve(root, values.input) : undefined,
        },
        environment.http,
      );
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    if (positionals[0] === "preview") {
      const report = await preview(
        await readProject(root, values.config),
        values.input ? resolve(root, values.input) : undefined,
        values.form,
        values.origin,
      );
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (values.output) {
        await writeOutput(
          resolve(root, values.output),
          values.output.endsWith(".html") ? previewHtml(report) : json,
          values.force,
        );
        console.log("Preview written to the requested output file.");
      } else console.log(json.trimEnd());
      return report.errors.length === 0 ? 0 : 1;
    }
    if (positionals[0] === "doctor" && values.endpoint) {
      const report = await remoteDoctor(
        await readProject(root, values.config),
        values.endpoint,
        values.form,
        environment.http,
      );
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const form of report.forms) {
          console.log(`${form.id}: ${form.ready ? "ready" : "not ready"}`);
          for (const item of form.diagnostics)
            console.log(
              `  ${item.code}: ${item.name}${item.destinationId ? ` (${item.destinationId})` : ""}`,
            );
        }
        console.log(report.note);
      }
      return report.ready ? 0 : 1;
    }
    if (positionals[0] === "doctor") {
      const report = await diagnose(
        await readProject(root, values.config),
        values.local,
        values.form,
      );
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const form of report.forms) {
          console.log(`${form.id}: ${form.destinations.join(", ")}`);
          console.log(
            `  Required secrets: ${form.requiredSecrets.join(", ") || "none"}`,
          );
          console.log(
            `  Required bindings: ${form.requiredBindings.join(", ") || "none"}`,
          );
        }
        for (const diagnostic of report.diagnostics)
          console.log(
            `${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnostic.formId ? ` (${diagnostic.formId})` : ""}: ${diagnostic.message}`,
          );
        console.log(report.note);
      }
      return report.valid && (!values.strict || report.diagnostics.length === 0)
        ? 0
        : 1;
    }
    if (positionals[0] !== "init")
      throw new ToolError(
        "Unknown command. Use --help for available commands.",
      );
    const options = { ...values };
    const prompts = interactive
      ? (environment.prompts ?? new TerminalPrompts())
      : undefined;
    try {
      if (prompts) {
        options.mode ??= await prompts.ask(
          "Submission mode (browser/server)",
          "server",
        );
        if (!options.provider && !options.providers)
          options.providers = await prompts.ask(
            "Providers (slack,discord,email,webhook)",
          );
        const selected = selectedProviders(options);
        if (options.mode === "browser")
          options.origin ??= await prompts.ask("Exact browser origin");
        if (selected.includes("email")) {
          options["email-transport"] ??= await prompts.ask(
            "Email transport (cloudflare/resend/smtp)",
            "cloudflare",
          );
          options.from ??= await prompts.ask("Email sender");
          options.to ??= await prompts.ask(
            "Email recipients (comma-separated)",
          );
        }
        if (selected.includes("webhook"))
          options["webhook-auth"] ??= await prompts.ask(
            "Webhook authentication (signing/bearer/both/none)",
            "signing",
          );
      }
      await createStarter(root, options);
    } finally {
      prompts?.close();
    }
    return 0;
  } catch (error) {
    console.error(
      error instanceof ToolError
        ? error.message
        : "Command failed. Check the input files and configuration; no error details are printed.",
    );
    return 1;
  }
}
