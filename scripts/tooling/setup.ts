import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
import {
  applyConfiguration,
  type ConfigurationChange,
  configureProject,
  restoreConfiguration,
} from "./configure";
import { prepareCredentials, saveCredentials } from "./credentials";
import { diagnose } from "./doctor";
import { ToolError } from "./errors";
import { preview } from "./preview";
import { type Project, readProject } from "./project";
import type { Prompts } from "./prompts";
import {
  type ProviderOptions,
  providerTypes,
  selectedProviders,
} from "./providers";

const execute = promisify(execFile);
export type SetupOptions = ProviderOptions & {
  config?: string | undefined;
  input?: string | undefined;
  form?: string | undefined;
  origin?: string | undefined;
  "dry-run"?: boolean | undefined;
};
async function templateChange(
  project: Project,
  required: readonly string[],
): Promise<ConfigurationChange | undefined> {
  const path = `${project.secretsPath}.example`;
  let before: string | undefined;
  try {
    before = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (Object.values(parseEnv(before ?? "")).some(Boolean))
    throw new ToolError(
      "Remove credential values from .dev.vars.example. Keep real values in ignored .dev.vars.",
    );
  let after = before ?? "";
  const guards = new Set([
    "SERVER_API_KEY",
    ...Object.values(project.config.forms).flatMap(
      (form) =>
        form.guards?.flatMap((guard) => [...(guard.secretNames ?? [])]) ?? [],
    ),
  ]);
  for (const name of required) {
    const present = new RegExp(`^([ \\t]*#\\s*)?${name}=`, "m");
    if (!present.test(after))
      after += `${after && !after.endsWith("\n") ? "\n" : ""}${guards.has(name) ? "" : "# "}${name}=\n`;
    else if (!guards.has(name))
      after = after.replace(new RegExp(`^${name}=\\s*$`, "m"), `# ${name}=`);
  }
  return before !== after ? { path, before, after } : undefined;
}

export async function setupProject(
  root: string,
  originalOptions: SetupOptions,
  prompts?: Prompts,
) {
  const options = { ...originalOptions };
  let project = await readProject(root, options.config);
  const changes: ConfigurationChange[] = [];
  let selection: Awaited<ReturnType<typeof configureProject>> | undefined;
  if (options.provider !== undefined && options.providers !== undefined)
    selectedProviders(options);
  if (prompts && !options["dry-run"]) {
    const ids = Object.keys(project.config.forms);
    options.form ??=
      ids.length === 1 ? ids[0] : await prompts.ask(`Form (${ids.join(", ")})`);
    const form = options.form && project.config.forms[options.form];
    if (!form) throw new ToolError("Choose a configured form.");
    if (!options.provider && !options.providers) {
      const defaults = [
        ...new Set(
          form.destinations.map(
            (id) => project.config.destinations[id]?.provider,
          ),
        ),
      ]
        .filter((type) =>
          providerTypes.includes(type as (typeof providerTypes)[number]),
        )
        .join(",");
      options.providers = await prompts.ask(
        "Providers (slack,discord,email,webhook)",
        defaults,
      );
    }
    const selected = selectedProviders(options);
    const existing = new Set(
      form.destinations.map((id) => project.config.destinations[id]?.provider),
    );
    if (selected.includes("email") && !existing.has("email")) {
      if (!/email:\s*[\s\S]*?transport:/.test(project.entrySource))
        options["email-transport"] ??= await prompts.ask(
          "Email transport (cloudflare/resend)",
          "cloudflare",
        );
      options.from ??= await prompts.ask("Email sender");
      options.to ??= await prompts.ask("Email recipients (comma-separated)");
    }
    if (selected.includes("webhook") && !existing.has("webhook"))
      options["webhook-auth"] ??= await prompts.ask(
        "Webhook authentication (signing/bearer/both/none)",
        "signing",
      );
  }
  if (options.provider !== undefined || options.providers !== undefined) {
    selection = await configureProject(root, project, options);
    project = selection.project;
    options.form ??= selection.formId;
    changes.push(...selection.changes);
  }
  const report = await diagnose(project, false, options.form);
  if (report.diagnostics.length)
    throw new ToolError(
      report.diagnostics
        .map((item) => `${item.code}: ${item.message}`)
        .join("\n"),
    );
  const rendered = await preview(
    project,
    options.input ? resolve(root, options.input) : project.fixturePath,
    options.form,
    options.origin,
  );
  if (rendered.errors.length)
    throw new ToolError(
      rendered.errors
        .map((item) => `${item.destinationId}: ${item.code}`)
        .join("\n"),
    );
  const requiredSecrets = [
    ...new Set(
      report.forms
        .filter((form) => !options.form || form.id === options.form)
        .flatMap((form) => form.requiredSecrets),
    ),
  ].sort();
  const template = await templateChange(project, requiredSecrets);
  if (template) changes.push(template);
  const base = {
    credentials: relative(root, project.secretsPath),
    formId: rendered.formId,
    destinations: rendered.previews.length,
    requiredSecrets,
    changes: changes.map((change) => relative(root, change.path)),
    routes:
      selection?.routes ??
      project.config.forms[rendered.formId]?.destinations ??
      [],
    additions: selection?.additions ?? [],
  };
  if (options["dry-run"])
    return {
      ...base,
      dryRun: true,
      created: false,
      migrated: false,
      missingSecrets: [] as string[],
    };
  // Finish all prompts and validation before writing configuration or credentials.
  const credentials = await prepareCredentials(
    project,
    requiredSecrets,
    prompts,
  );
  let bindingsBefore: string | undefined;
  try {
    bindingsBefore = await readFile(project.bindingsPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  await applyConfiguration(changes);
  let created: boolean;
  try {
    try {
      await execute(
        process.execPath,
        [
          join(root, "node_modules/wrangler/bin/wrangler.js"),
          "types",
          "--config",
          project.wranglerPath,
          project.bindingsPath,
          "--env-interface",
          "WorkerBindings",
          "--include-runtime",
          "false",
        ],
        { cwd: root, timeout: 30_000 },
      );
    } catch {
      throw new ToolError(
        "Cannot generate Worker bindings. Run npm ci, then npm run types:generate to inspect Wrangler diagnostics.",
      );
    }
    created = await saveCredentials(
      project.secretsPath,
      credentials.content,
      credentials.expectedContent,
    );
  } catch (error) {
    await restoreConfiguration(changes);
    if (bindingsBefore === undefined)
      await rm(project.bindingsPath, { force: true });
    else await writeFile(project.bindingsPath, bindingsBefore);
    throw error;
  }
  return {
    ...base,
    dryRun: false,
    created,
    migrated: credentials.migrated,
    missingSecrets: credentials.missingSecrets,
  };
}
