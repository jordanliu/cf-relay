import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { diagnose } from "./doctor";
import { ToolError } from "./errors";
import { preview } from "./preview";
import { readProject } from "./project";

const execute = promisify(execFile);

export async function setupProject(
  root: string,
  options: {
    config?: string | undefined;
    input?: string | undefined;
    form?: string | undefined;
    origin?: string | undefined;
  },
) {
  const project = await readProject(root, options.config);
  const report = await diagnose(project);
  if (report.diagnostics.length > 0)
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
  if (rendered.errors.length > 0)
    throw new ToolError(
      rendered.errors
        .map((item) => `${item.destinationId}: ${item.code}`)
        .join("\n"),
    );

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

  const requiredSecrets = [
    ...new Set(report.forms.flatMap((form) => form.requiredSecrets)),
  ].sort();
  let created = false;
  let migrated = false;
  const path = project.secretsPath;
  try {
    let content: string | undefined;
    if (project.legacySecretsPath) {
      try {
        content = await readFile(project.legacySecretsPath, "utf8");
        migrated = true;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    }
    content ??= `${requiredSecrets
      .map(
        (name) =>
          `${name}=${name === "SERVER_API_KEY" ? randomBytes(32).toString("base64url") : ""}`,
      )
      .join("\n")}\n`;
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw new ToolError(
        "Cannot create local credentials. Check directory permissions.",
      );
  }

  return {
    credentials: relative(root, path),
    created,
    migrated,
    formId: rendered.formId,
    destinations: rendered.previews.length,
    requiredSecrets,
  };
}
