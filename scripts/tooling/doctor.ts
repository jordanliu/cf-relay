import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { secretNames } from "@cf-relay/core";
import { dependencyBindings, inspectSource, type Project } from "./project";

type Diagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  formId?: string;
};

export async function diagnose(project: Project, local = false) {
  const diagnostics: Diagnostic[] = [];
  const { config, wrangler, source, entrySource } = project;
  const add = (
    severity: Diagnostic["severity"],
    code: string,
    message: string,
    formId?: string,
  ) =>
    diagnostics.push({
      severity,
      code,
      message,
      ...(formId ? { formId } : {}),
    });
  const bindings = new Set<string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) collect(child);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "binding" || key === "name") &&
        typeof child === "string" &&
        /^[A-Z][A-Z0-9_]*$/.test(child)
      )
        bindings.add(child);
      else collect(child);
    }
  };
  collect(wrangler);
  for (const required of ["DELIVERIES", "FAILURES"]) {
    if (
      !wrangler.queues?.producers?.some(
        (producer) => producer.binding === required && producer.queue,
      )
    )
      add(
        "error",
        "QUEUE_BINDING_MISSING",
        `Configure the ${required} Queue producer in wrangler.jsonc.`,
      );
  }
  const delivery = wrangler.queues?.producers?.find(
    (producer) => producer.binding === "DELIVERIES",
  )?.queue;
  const failure = wrangler.queues?.producers?.find(
    (producer) => producer.binding === "FAILURES",
  )?.queue;
  if (
    !delivery ||
    !failure ||
    !wrangler.queues?.consumers?.some(
      (consumer) =>
        consumer.queue === delivery && consumer.dead_letter_queue === failure,
    )
  )
    add(
      "error",
      "QUEUE_CONSUMER_MISMATCH",
      "Configure a consumer for the delivery Queue with the failure Queue as its dead-letter Queue.",
    );
  let localValues: Record<string, string | undefined> = {};
  if (local) {
    try {
      localValues = parseEnv(
        await readFile(join(project.directory, ".dev.vars"), "utf8"),
      );
    } catch {
      add(
        "error",
        "LOCAL_SECRETS_FILE_MISSING",
        "Create .dev.vars beside relay.config.ts using .dev.vars.example and supply local credentials.",
      );
    }
  }
  const forms = Object.entries(config.forms).map(([id, form]) => {
    const dependencies = dependencyBindings(
      entrySource,
      new Set(
        form.destinations.map(
          (destination) => config.destinations[destination]?.provider ?? "",
        ),
      ),
    );
    const requiredBindings = [
      ...new Set([
        ...(form.guards?.flatMap((guard) => [...(guard.bindingNames ?? [])]) ??
          []),
        ...dependencies.filter(
          (name) => name === "EMAIL" || bindings.has(name),
        ),
      ]),
    ].sort();
    const requiredSecrets = [
      ...new Set([
        ...(form.guards?.flatMap((guard) => [...(guard.secretNames ?? [])]) ??
          []),
        ...form.destinations.flatMap((destination) =>
          secretNames(config.destinations[destination]),
        ),
        ...dependencies.filter(
          (name) => name !== "EMAIL" && !bindings.has(name),
        ),
      ]),
    ].sort();
    for (const name of requiredBindings) {
      if (name !== "EMAIL" && !bindings.has(name))
        add(
          "error",
          "GUARD_BINDING_MISSING",
          `Declare the ${name} binding in wrangler.jsonc.`,
          id,
        );
    }
    if (
      dependencies.includes("EMAIL") &&
      !wrangler.send_email?.some((binding) => binding.name === "EMAIL")
    )
      add(
        "error",
        "EMAIL_BINDING_MISSING",
        "Declare the EMAIL send_email binding for the native Cloudflare transport.",
        id,
      );
    for (const name of requiredSecrets) {
      if (local && !(localValues[name] || wrangler.vars?.[name]))
        add(
          "error",
          "LOCAL_SECRET_MISSING",
          `Supply local ${name} in .dev.vars.`,
          id,
        );
      if (Object.hasOwn(wrangler.vars ?? {}, name))
        add(
          "warning",
          "SECRET_IN_VARS",
          `Move ${name} from Wrangler vars to a secret binding.`,
          id,
        );
      if (
        !new RegExp(`\\b${name}\\s*[?]?:\\s*string\\b`).test(entrySource) &&
        !Object.hasOwn(wrangler.vars ?? {}, name)
      )
        add(
          "warning",
          "SECRET_TYPE_MISSING",
          `Declare ${name}: string in the Worker environment type.`,
          id,
        );
    }
    if (
      form.guards?.some((guard) => guard.type === "turnstile") &&
      !form.allowedOrigins?.length
    )
      add(
        "error",
        "BROWSER_ORIGIN_MISSING",
        "Set allowedOrigins for the browser form.",
        id,
      );
    if (
      form.allowedOrigins?.some((origin) =>
        /(^|\.)example\.(com|org|net)$/.test(new URL(origin).hostname),
      )
    )
      add(
        "warning",
        "PLACEHOLDER_ORIGIN",
        "Replace the example origin with the client page's exact origin.",
        id,
      );
    for (const destinationId of form.destinations) {
      const destination = config.destinations[destinationId];
      const emailBinding = wrangler.send_email?.find(
        (binding) => binding.name === "EMAIL",
      );
      if (
        destination?.provider === "email" &&
        dependencies.includes("EMAIL") &&
        emailBinding
      ) {
        const senders = emailBinding.allowed_sender_addresses;
        const recipients = emailBinding.allowed_destination_addresses;
        if (
          (senders && !senders.includes(String(destination.from))) ||
          (recipients &&
            Array.isArray(destination.to) &&
            destination.to.some(
              (address) => !recipients.includes(String(address)),
            ))
        )
          add(
            "error",
            "EMAIL_ALLOWLIST_MISMATCH",
            `The EMAIL sender or recipient allowlist excludes an address in destination ${destinationId}. Update the destination or Wrangler allowlists.`,
            id,
          );
      }
      if (
        destination?.provider === "email" &&
        [
          destination.from,
          ...(Array.isArray(destination.to) ? destination.to : []),
        ].some(
          (value) =>
            typeof value === "string" && /@example\.(com|org|net)$/.test(value),
        )
      )
        add(
          "warning",
          "PLACEHOLDER_EMAIL",
          `Replace the sample sender and recipients for destination ${destinationId}.`,
          id,
        );
    }
    return {
      id,
      destinations: [...form.destinations],
      requiredSecrets,
      requiredBindings,
    };
  });
  const hostnames = new Set(
    Object.values(config.forms).flatMap(
      (form) =>
        form.allowedOrigins?.map((origin) => new URL(origin).hostname) ?? [],
    ),
  );
  for (const hostname of inspectSource(source, "expectedHostname")) {
    if (!hostnames.has(hostname))
      add(
        "warning",
        "TURNSTILE_HOSTNAME_MISMATCH",
        "A literal expectedHostname does not match any configured browser origin. Check Turnstile hostname and origin settings.",
      );
  }
  const valid = !diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  return {
    valid,
    forms,
    diagnostics,
    note: "Local configuration inspection only. Live secret values, provider acceptance, sender DNS, and dynamic dependency or Turnstile settings are not verified.",
  };
}
