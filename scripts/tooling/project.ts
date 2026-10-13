import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineRelay, type RelayConfig } from "@cf-relay/core";
import { build } from "esbuild";
import ts from "typescript";
import { ToolError } from "./errors";
import { projectPaths } from "./paths";

export interface WranglerConfig {
  name?: string;
  main?: string;
  vars?: Record<string, unknown>;
  queues?: {
    producers?: { binding: string; queue: string }[];
    consumers?: { queue: string; dead_letter_queue?: string }[];
  };
  send_email?: {
    name: string;
    allowed_sender_addresses?: string[];
    allowed_destination_addresses?: string[];
  }[];
  ratelimits?: { name: string; namespace_id: string }[];
  [key: string]: unknown;
}

export async function readProject(
  root: string,
  configPath?: string,
  overrides: {
    source?: string;
    entrySource?: string;
    wrangler?: WranglerConfig;
  } = {},
) {
  const paths = projectPaths(root, configPath);
  let source: string;
  let wrangler: WranglerConfig;
  let entrySource: string;
  try {
    source = overrides.source ?? (await readFile(paths.configPath, "utf8"));
    const parsed = ts.parseConfigFileTextToJson(
      "wrangler.jsonc",
      await readFile(paths.wranglerPath, "utf8"),
    );
    if (parsed.error || !parsed.config || typeof parsed.config !== "object")
      throw new Error();
    wrangler = overrides.wrangler ?? parsed.config;
    if (typeof wrangler.main !== "string") throw new Error();
    entrySource =
      overrides.entrySource ??
      (await readFile(
        resolve(dirname(paths.wranglerPath), wrangler.main),
        "utf8",
      ));
  } catch {
    throw new ToolError(
      "Cannot read the relay configuration, Wrangler JSONC, or Worker entry point. Check --config and the Wrangler main path.",
    );
  }
  const scratch = join(root, ".scratch");
  await mkdir(scratch, { recursive: true });
  const output = join(scratch, `relay-config-${randomUUID()}.mjs`);
  let config: RelayConfig;
  try {
    await build({
      stdin: {
        contents: source,
        resolveDir: dirname(paths.configPath),
        sourcefile: paths.configPath,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: output,
      logLevel: "silent",
    });
    const loaded = await import(pathToFileURL(output).href);
    config = defineRelay(loaded.default as RelayConfig);
  } catch {
    throw new ToolError(
      "Relay configuration could not be loaded or validated. Run npm run typecheck and check providers, destinations, schemas, and guards.",
    );
  } finally {
    await rm(output, { force: true });
  }
  return { ...paths, config, source, entrySource, wrangler };
}

export type Project = Awaited<ReturnType<typeof readProject>>;

export function readinessSecrets(source: string): string[] {
  const file = ts.createSourceFile(
    "entry.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === "readinessGuard"
    ) {
      const collect = (child: ts.Node) => {
        if (
          ts.isCallExpression(child) &&
          child.expression.getText(file) === "secret" &&
          child.arguments.length === 1 &&
          child.arguments[0] &&
          ts.isStringLiteralLike(child.arguments[0])
        )
          names.add(child.arguments[0].text);
        ts.forEachChild(child, collect);
      };
      collect(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...names];
}

export function inspectSource(source: string, property: string): string[] {
  const values: string[] = [];
  const file = ts.createSourceFile(
    "configuration.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file).replace(/["']/g, "") === property &&
      ts.isStringLiteralLike(node.initializer)
    )
      values.push(node.initializer.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

export function dependencyBindings(
  source: string,
  providers: Set<string>,
): string[] {
  const bindings = new Set<string>();
  const file = ts.createSourceFile(
    "entry.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === "providerDependencies" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const factory of node.initializer.properties) {
        if (
          !ts.isPropertyAssignment(factory) ||
          !providers.has(factory.name.getText(file).replace(/["']/g, ""))
        )
          continue;
        const fn = factory.initializer;
        if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) continue;
        const parameter = fn.parameters[0]?.name.getText(file);
        const collect = (child: ts.Node) => {
          if (
            ts.isPropertyAccessExpression(child) &&
            child.expression.getText(file) === parameter &&
            /^[A-Z][A-Z0-9_]*$/.test(child.name.text)
          )
            bindings.add(child.name.text);
          ts.forEachChild(child, collect);
        };
        collect(fn.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...bindings];
}

export async function writeOutput(
  path: string,
  content: string,
  force = false,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: force ? "w" : "wx" });
  } catch {
    throw new ToolError(
      "Cannot write the output file. Check its directory and use --force only when replacing an existing output is intended.",
    );
  }
}
