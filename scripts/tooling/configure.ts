import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { secretNames } from "@cf-relay/core";
import ts from "typescript";
import { ToolError } from "./errors";
import { type Project, readinessSecrets, readProject } from "./project";
import {
  destinationSource,
  type ProviderOptions,
  providerSecrets,
  providerSettings,
  selectedProviders,
} from "./providers";
import { formatSource } from "./starter";

type Edit = { start: number; end: number; text: string };
export type ConfigurationChange = {
  path: string;
  before: string | undefined;
  after: string;
};
function unsupported(): never {
  throw new ToolError(
    "Guided setup supports static defineProviders, defineDestinations, and defineForms declarations and a WorkerEnv type. Edit relay.config.ts and the Worker entry point manually for computed configuration. No configuration files were changed.",
  );
}
function key(node: ts.PropertyName) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node)
    ? node.text
    : unsupported();
}
function properties(node: ts.ObjectLiteralExpression) {
  return node.properties.map((property) =>
    ts.isPropertyAssignment(property) ? property : unsupported(),
  );
}
function property(node: ts.ObjectLiteralExpression, name: string) {
  return properties(node).find((item) => key(item.name) === name);
}
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;
}
function builder(file: ts.SourceFile, name: string) {
  const found: { name: string; call: ts.CallExpression }[] = [];
  for (const statement of file.statements)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
          continue;
        const initializer = unwrap(declaration.initializer);
        if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === name
        )
          found.push({ name: declaration.name.text, call: initializer });
      }
  if (found.length !== 1 || !found[0]) unsupported();
  return found[0];
}
class SourceEditor {
  readonly file: ts.SourceFile;
  private readonly edits: Edit[] = [];
  private readonly imports = new Map<string, Set<string>>();
  constructor(
    readonly text: string,
    json = false,
  ) {
    this.file = json
      ? ts.parseJsonText("wrangler.jsonc", text)
      : ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true);
  }
  replace(node: ts.Node, text: string) {
    this.edits.push({ start: node.getStart(this.file), end: node.end, text });
  }
  append(
    node:
      | ts.ObjectLiteralExpression
      | ts.ArrayLiteralExpression
      | ts.TypeLiteralNode,
    additions: string[],
  ) {
    if (!additions.length) return;
    const items = ts.isObjectLiteralExpression(node)
      ? node.properties
      : ts.isArrayLiteralExpression(node)
        ? node.elements
        : node.members;
    const last = items.at(-1);
    const position = last?.end ?? node.getStart(this.file) + 1;
    const separator = ts.isTypeLiteralNode(node) ? "\n" : last ? ",\n" : "\n";
    this.edits.push({
      start: position,
      end: position,
      text: `${separator}${additions.join(ts.isTypeLiteralNode(node) ? "\n" : ",\n")}`,
    });
  }
  import(module: string, name: string) {
    for (const statement of this.file.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const specifier of bindings.elements)
          if (specifier.name.text === name) {
            if (
              !ts.isStringLiteral(statement.moduleSpecifier) ||
              statement.moduleSpecifier.text !== module ||
              (specifier.propertyName?.text ?? name) !== name ||
              statement.importClause?.isTypeOnly ||
              specifier.isTypeOnly
            )
              unsupported();
            return;
          }
      if (
        statement.importClause?.name?.text === name ||
        (bindings &&
          ts.isNamespaceImport(bindings) &&
          bindings.name.text === name)
      )
        unsupported();
    }
    for (const statement of this.file.statements) {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name?.text === name
      )
        unsupported();
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) && declaration.name.text === name,
        )
      )
        unsupported();
    }
    const names = this.imports.get(module) ?? new Set<string>();
    names.add(name);
    this.imports.set(module, names);
  }
  finish() {
    let result = this.text;
    for (const edit of this.edits.sort((a, b) => b.start - a.start))
      result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    const imports = [...this.imports]
      .map(
        ([module, names]) =>
          `import { ${[...names].join(", ")} } from ${JSON.stringify(module)};`,
      )
      .join("\n");
    return imports ? `${imports}\n${result}` : result;
  }
}

export async function configureProject(
  root: string,
  project: Project,
  options: ProviderOptions & { form?: string | undefined },
) {
  const selected = selectedProviders(options);
  const settings = providerSettings(options, selected);
  const formIds = Object.keys(project.config.forms);
  const formId =
    options.form ?? (formIds.length === 1 ? formIds[0] : undefined);
  if (!formId || !Object.hasOwn(project.config.forms, formId))
    throw new ToolError("Choose a configured form with --form formId.");
  const source = new SourceEditor(project.source);
  const providers = builder(source.file, "defineProviders");
  const destinations = builder(source.file, "defineDestinations");
  const forms = builder(source.file, "defineForms");
  const providerArray =
    providers.call.arguments[0] && unwrap(providers.call.arguments[0]);
  const destinationObject =
    destinations.call.arguments[1] && unwrap(destinations.call.arguments[1]);
  const formObject = forms.call.arguments[1] && unwrap(forms.call.arguments[1]);
  if (
    !providerArray ||
    !ts.isArrayLiteralExpression(providerArray) ||
    !destinationObject ||
    !ts.isObjectLiteralExpression(destinationObject) ||
    !formObject ||
    !ts.isObjectLiteralExpression(formObject) ||
    destinations.call.arguments[0]?.getText(source.file) !== providers.name ||
    forms.call.arguments[0]?.getText(source.file) !== destinations.name
  )
    unsupported();
  properties(destinationObject);
  if (
    providerArray.elements.some(
      (element) =>
        !ts.isCallExpression(element) ||
        !ts.isIdentifier(element.expression) ||
        element.arguments.length,
    )
  )
    unsupported();
  for (const item of properties(destinationObject))
    if (!ts.isObjectLiteralExpression(item.initializer)) unsupported();
  const exported = source.file.statements.find(
    ts.isExportAssignment,
  )?.expression;
  if (
    !exported ||
    !ts.isCallExpression(exported) ||
    exported.expression.getText(source.file) !== "defineRelay" ||
    !exported.arguments[0] ||
    !ts.isObjectLiteralExpression(exported.arguments[0])
  )
    unsupported();
  const references: Record<string, string> = {
    providers: providers.name,
    destinations: destinations.name,
    forms: forms.name,
  };
  for (const item of exported.arguments[0].properties) {
    if (ts.isShorthandPropertyAssignment(item)) {
      if (references[item.name.text] !== item.name.text) unsupported();
    } else if (ts.isPropertyAssignment(item)) {
      if (references[key(item.name)] !== item.initializer.getText(source.file))
        unsupported();
    } else unsupported();
  }
  const declaredForm = property(formObject, formId)?.initializer;
  if (
    !declaredForm ||
    !ts.isCallExpression(declaredForm) ||
    declaredForm.expression.getText(source.file) !== "defineForm"
  )
    unsupported();
  const formBody = declaredForm.arguments[0];
  if (!formBody || !ts.isObjectLiteralExpression(formBody)) unsupported();
  const route = property(formBody, "destinations")?.initializer;
  if (
    !route ||
    !ts.isArrayLiteralExpression(route) ||
    route.elements.some((element) => !ts.isStringLiteralLike(element))
  )
    unsupported();
  const current = project.config.forms[formId];
  if (!current) unsupported();
  if (
    current.destinations.some(
      (id) =>
        !["slack", "discord", "email", "webhook"].includes(
          project.config.destinations[id]?.provider ?? "",
        ),
    )
  )
    throw new ToolError(
      "This form uses a custom provider. Edit its routing manually. No configuration files were changed.",
    );
  const routes: string[] = [];
  const additions: { id: string; provider: string }[] = [];
  const definitions: string[] = [];
  const imports: string[] = [];
  const entry = new SourceEditor(project.entrySource);
  const relay = builder(entry.file, "createCloudflareRelay");
  const runtimeOptions = relay.call.arguments[1];
  if (!runtimeOptions || !ts.isObjectLiteralExpression(runtimeOptions))
    unsupported();
  const readinessGuard = property(runtimeOptions, "readinessGuard");
  if (
    readinessGuard &&
    (!ts.isCallExpression(readinessGuard.initializer) ||
      readinessGuard.initializer.expression.getText(entry.file) !== "apiKey" ||
      !readinessSecrets(
        `const options = { ${readinessGuard.getText(entry.file)} };`,
      ).length)
  )
    unsupported();
  const dependencyObject = property(
    runtimeOptions,
    "providerDependencies",
  )?.initializer;
  if (!dependencyObject || !ts.isObjectLiteralExpression(dependencyObject))
    unsupported();
  const emailFactory = property(dependencyObject, "email");
  if (
    emailFactory &&
    options["email-transport"] &&
    ((emailFactory.getText(entry.file).includes("cloudflareEmailTransport") &&
      settings.transport !== "cloudflare") ||
      (emailFactory.getText(entry.file).includes("resendEmailTransport") &&
        settings.transport !== "resend"))
  )
    throw new ToolError(
      "Email transport is shared by all forms. Change it manually with the destination revision and draining procedure.",
    );
  const effectiveTransport = emailFactory
    ? emailFactory.getText(entry.file).includes("cloudflareEmailTransport")
      ? "cloudflare"
      : emailFactory.getText(entry.file).includes("resendEmailTransport")
        ? "resend"
        : undefined
    : settings.transport;
  const wrangler = structuredClone(project.wrangler);
  const usedSecrets = new Set([
    ...Object.values(project.config.destinations).flatMap(secretNames),
    ...Object.values(project.config.forms).flatMap(
      (form) =>
        form.guards?.flatMap((guard) => [...(guard.secretNames ?? [])]) ?? [],
    ),
    ...readinessSecrets(project.entrySource),
  ]);
  for (const provider of selected) {
    const retained = current.destinations.filter(
      (id) => project.config.destinations[id]?.provider === provider,
    );
    routes.push(...retained);
    if (retained.length) {
      if (provider === "email" && (options.from || options.to))
        throw new ToolError(
          "Existing email addresses are preserved. Edit destinations manually with the revision and draining procedure.",
        );
      if (provider === "webhook" && options["webhook-auth"])
        throw new ToolError(
          "Existing webhook authentication is preserved. Edit its destination manually with a new revision.",
        );
      continue;
    }
    let id = `${formId.slice(0, 100)}_${provider}`;
    for (
      let suffix = 2;
      Object.hasOwn(project.config.destinations, id) ||
      additions.some((item) => item.id === id);
      suffix++
    )
      id = `${formId.slice(0, 95)}_${provider}_${suffix}`;
    const names =
      provider === "email" ? [] : providerSecrets(provider, settings);
    let prefix =
      names.some((name) => usedSecrets.has(name)) ||
      (provider !== "email" &&
        Object.values(project.config.destinations).some(
          (destination) => destination.provider === provider,
        ))
        ? `DEST_${id.toUpperCase().replaceAll("-", "_")}_`
        : "";
    const basePrefix = prefix;
    for (
      let suffix = 2;
      names.some((name) => usedSecrets.has(`${prefix}${name}`));
      suffix++
    )
      prefix = `${basePrefix}${suffix}_`;
    for (const name of names) usedSecrets.add(`${prefix}${name}`);
    definitions.push(
      `${JSON.stringify(id)}: ${destinationSource(provider, settings, prefix)}`,
    );
    routes.push(id);
    additions.push({ id, provider });
    if (!project.config.providers.some((item) => item.type === provider)) {
      source.import(`@cf-relay/provider-${provider}`, `${provider}Provider`);
      imports.push(`${provider}Provider()`);
    }
    source.import("@cf-relay/core", "secret");
    if (provider === "email") {
      if (!effectiveTransport)
        throw new ToolError(
          "Custom email factories require manual binding configuration. No configuration files were changed.",
        );
      if (!emailFactory) {
        entry.import(
          `@cf-relay/email-${effectiveTransport}`,
          `${effectiveTransport}EmailTransport`,
        );
        entry.append(dependencyObject, [
          `email: (env: WorkerEnv) => ({ transport: ${effectiveTransport}EmailTransport(env.${effectiveTransport === "cloudflare" ? "EMAIL" : "RESEND_API_KEY"}) })`,
        ]);
      }
      if (effectiveTransport === "cloudflare") {
        wrangler.send_email ??= [];
        const binding = wrangler.send_email.find(
          (value) => value.name === "EMAIL",
        );
        if (!binding)
          wrangler.send_email.push({
            name: "EMAIL",
            allowed_sender_addresses: [settings.from],
            allowed_destination_addresses: settings.to,
          });
        else {
          if ("destination_address" in binding)
            throw new ToolError(
              "Update the restricted EMAIL binding manually before adding another destination.",
            );
          if (binding.allowed_sender_addresses)
            binding.allowed_sender_addresses = [
              ...new Set([...binding.allowed_sender_addresses, settings.from]),
            ];
          if (binding.allowed_destination_addresses)
            binding.allowed_destination_addresses = [
              ...new Set([
                ...binding.allowed_destination_addresses,
                ...settings.to,
              ]),
            ];
        }
      }
    }
  }
  source.append(providerArray, imports);
  source.append(destinationObject, definitions);
  source.replace(route, JSON.stringify(routes));
  if (!readinessGuard) {
    entry.import("@cf-relay/core", "secret");
    entry.import("@cf-relay/policies", "apiKey");
    entry.append(runtimeOptions, [
      'readinessGuard: apiKey({ secret: secret("SERVER_API_KEY") })',
    ]);
  }
  const envAlias = entry.file.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "WorkerEnv",
  );
  const envBody =
    envAlias &&
    (ts.isTypeLiteralNode(envAlias.type)
      ? envAlias.type
      : ts.isIntersectionTypeNode(envAlias.type)
        ? envAlias.type.types.find(ts.isTypeLiteralNode)
        : undefined);
  if (!envBody) unsupported();
  const intermediate = await readProject(root, project.configPath, {
    source: source.finish(),
    entrySource: entry.finish(),
    wrangler,
  });
  const needed = new Set([
    ...readinessSecrets(entry.finish()),
    ...Object.values(intermediate.config.forms).flatMap((form) =>
      form.destinations.flatMap((id) =>
        secretNames(intermediate.config.destinations[id]),
      ),
    ),
  ]);
  if (selected.includes("email") && effectiveTransport === "resend")
    needed.add("RESEND_API_KEY");
  const declared = new Set(
    envBody.members.flatMap((member) =>
      ts.isPropertySignature(member) && member.name ? [key(member.name)] : [],
    ),
  );
  entry.append(
    envBody,
    [...needed]
      .filter((name) => !declared.has(name))
      .map((name) => `${name}: string;`),
  );
  const entryPath = resolve(
    dirname(project.wranglerPath),
    String(wrangler.main),
  );
  const changes: ConfigurationChange[] = [];
  const add = async (path: string, before: string, after: string) => {
    const formatted = await formatSource(root, path, after);
    if (formatted !== before) changes.push({ path, before, after: formatted });
  };
  await add(project.configPath, project.source, source.finish());
  await add(entryPath, project.entrySource, entry.finish());
  if (
    JSON.stringify(wrangler.send_email) !==
    JSON.stringify(project.wrangler.send_email)
  ) {
    const before = await readFile(project.wranglerPath, "utf8");
    const editor = new SourceEditor(before, true);
    const statement = editor.file.statements[0];
    if (
      !statement ||
      !ts.isExpressionStatement(statement) ||
      !ts.isObjectLiteralExpression(statement.expression)
    )
      unsupported();
    const existing = property(statement.expression, "send_email");
    if (existing)
      editor.replace(existing.initializer, JSON.stringify(wrangler.send_email));
    else
      editor.append(statement.expression, [
        `"send_email": ${JSON.stringify(wrangler.send_email)}`,
      ]);
    await add(project.wranglerPath, before, editor.finish());
  }
  const candidate = await readProject(root, project.configPath, {
    source:
      changes.find((change) => change.path === project.configPath)?.after ??
      project.source,
    entrySource:
      changes.find((change) => change.path === entryPath)?.after ??
      project.entrySource,
    wrangler,
  });
  return { project: candidate, changes, formId, routes, additions };
}

export async function applyConfiguration(
  changes: readonly ConfigurationChange[],
) {
  for (const change of changes) {
    let current: string | undefined;
    try {
      current = await readFile(change.path, "utf8");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    if (current !== change.before)
      throw new ToolError(
        "Configuration changed during setup. Run setup again; no files were changed.",
      );
  }
  const written: ConfigurationChange[] = [];
  try {
    for (const change of changes) {
      await writeFile(change.path, change.after);
      written.push(change);
    }
  } catch {
    await restoreConfiguration(written);
    throw new ToolError(
      "Cannot update configuration. Original files were restored.",
    );
  }
}
export async function restoreConfiguration(
  changes: readonly ConfigurationChange[],
) {
  for (const change of [...changes].reverse())
    if (change.before === undefined) await rm(change.path, { force: true });
    else await writeFile(change.path, change.before);
}
