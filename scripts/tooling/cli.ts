import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { diagnose } from "./doctor";
import { ToolError } from "./errors";
import { preview, previewHtml } from "./preview";
import { readProject, writeOutput } from "./project";
import { createStarter } from "./starter";

const help = `Usage: npm run <command> -- [options]

init     Generate a single-form, single-provider Worker starter.
         --mode browser|server --provider slack|discord|email
         --email-transport cloudflare|resend --origin https://your-domain
         --name worker-name --from sender --to recipient[,recipient]
         --output directory (default: apps/worker) --force

Existing files require --force. Local credential files are never overwritten.

doctor   Inspect configuration and required credentials without sending.
         --config path (default: apps/worker/relay.config.ts)
         --local (check .dev.vars) --strict (fail on warnings) --json

preview  Validate a fixture and render notifications without delivery.
         --input path --form formId (optional for a single-form config)
         --config path --origin https://client-domain
         --output path (.html for a page, otherwise JSON) --force
`;

export async function main(args: string[], root: string): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean" },
        mode: { type: "string" },
        provider: { type: "string" },
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
    if (positionals[0] === "doctor") {
      const report = await diagnose(
        await readProject(root, values.config),
        values.local,
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
    let mode = values.mode;
    let provider = values.provider;
    if ((!mode || !provider) && process.stdin.isTTY && process.stdout.isTTY) {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        mode ??= (
          await prompt.question("Submission mode (browser/server): ")
        ).trim();
        provider ??= (
          await prompt.question("Provider (slack/discord/email): ")
        ).trim();
      } finally {
        prompt.close();
      }
    }
    await createStarter(root, { ...values, mode, provider });
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
