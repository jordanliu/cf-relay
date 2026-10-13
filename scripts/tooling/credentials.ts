import { randomBytes } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { secretNames } from "@cf-relay/core";
import { ToolError } from "./errors";
import type { Project } from "./project";
import type { Prompts } from "./prompts";

export async function credentialContent(project: Project) {
  for (const path of [project.secretsPath, project.legacySecretsPath]) {
    if (!path) continue;
    try {
      if (!(await lstat(path)).isFile())
        throw new ToolError("Local credentials must be a regular file.");
      return {
        content: await readFile(path, "utf8"),
        migrated: path !== project.secretsPath,
        exists: path === project.secretsPath,
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "Cannot read local credentials. Check file permissions.",
      );
    }
  }
  return { content: "", migrated: false, exists: false };
}

function setValue(content: string, name: string, value: string) {
  const encoded = value.includes("'") ? JSON.stringify(value) : `'${value}'`;
  if (parseEnv(`${name}=${encoded}\n`)[name] !== value)
    throw new ToolError(
      `Enter ${name} manually in .dev.vars using dotenv syntax.`,
    );
  const lines = content.split("\n");
  const assignment = new RegExp(
    `^([ \\t]*(?:export\\s+)?${name}\\s*=)\\s*(?:''|"")?\\s*(#.*)?$`,
  );
  let matchAt = -1;
  for (let i = 0; i < lines.length; i++)
    if (assignment.test(lines[i] ?? "")) matchAt = i;
  if (matchAt >= 0) {
    const match = assignment.exec(lines[matchAt] ?? "");
    lines[matchAt] =
      `${match?.[1]}${encoded}${match?.[2] ? ` ${match[2]}` : ""}`;
    return lines.join("\n");
  }
  return `${content}${content && !content.endsWith("\n") ? "\n" : ""}${name}=${encoded}\n`;
}

export async function prepareCredentials(
  project: Project,
  names: readonly string[],
  prompts?: Prompts,
) {
  const original = await credentialContent(project);
  let content = original.content;
  let values = parseEnv(content);
  const signing = new Set(
    Object.values(project.config.destinations).flatMap((destination) =>
      secretNames(destination.signingSecret),
    ),
  );
  for (const name of names) {
    if (values[name]) continue;
    const generated =
      name === "SERVER_API_KEY"
        ? process.env.RELAY_API_KEY || randomBytes(32).toString("base64url")
        : signing.has(name)
          ? `whsec_${randomBytes(32).toString("base64")}`
          : undefined;
    const value =
      generated ?? (prompts ? await prompts.secret(name) : undefined);
    if (value !== undefined && (!value || /[\r\n\0]/.test(value)))
      throw new ToolError(`Supply a nonempty, single-line ${name}.`);
    if (value !== undefined) content = setValue(content, name, value);
    else if (!Object.hasOwn(values, name))
      content += `${content && !content.endsWith("\n") ? "\n" : ""}${name}=\n`;
    values = parseEnv(content);
  }
  return {
    content,
    migrated: original.migrated,
    expectedContent: original.exists ? original.content : undefined,
    missingSecrets: names.filter((name) => !values[name]),
  };
}

export async function saveCredentials(
  path: string,
  content: string,
  expectedContent: string | undefined,
) {
  let created = false;
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw new ToolError("Cannot save local credentials.");
    if (!(await lstat(path)).isFile())
      throw new ToolError("Local credentials must be a regular file.");
    if (
      expectedContent === undefined ||
      (await readFile(path, "utf8")) !== expectedContent
    )
      throw new ToolError(
        "Credentials changed during setup. Run setup again; existing values were preserved.",
      );
    await chmod(path, 0o600);
    if ((await readFile(path, "utf8")) !== content)
      await writeFile(path, content, { mode: 0o600 });
  }
  return created;
}
