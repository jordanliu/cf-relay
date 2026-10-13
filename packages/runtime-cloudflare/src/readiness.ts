import { type RelayConfig, secretNames } from "@cf-relay/core";
import { binding, cloudflareSecrets } from "./capabilities";

export interface ReadinessDiagnostic {
  code:
    | "QUEUE_BINDING_MISSING"
    | "SECRET_MISSING"
    | "GUARD_BINDING_MISSING"
    | "PROVIDER_DEPENDENCY_MISSING";
  name: string;
  destinationId?: string;
}
export interface FormReadiness {
  id: string;
  destinations: { id: string; provider: string; revision: string }[];
  ready: boolean;
  diagnostics: ReadinessDiagnostic[];
}
export interface ReadinessReport {
  ready: boolean;
  forms: FormReadiness[];
}

export async function checkFormReadiness(
  config: RelayConfig,
  id: string,
  env: object,
  dependenciesFor: (type: string) => object,
): Promise<FormReadiness> {
  const form = config.forms[id];
  if (!form) throw new Error("Unknown form");
  const diagnostics: ReadinessDiagnostic[] = [];
  for (const [name, method] of [
    ["DELIVERIES", "sendBatch"],
    ["FAILURES", "send"],
  ]) {
    const value = binding(env, name ?? "");
    if (
      !value ||
      typeof value !== "object" ||
      !method ||
      !(method in value) ||
      typeof Reflect.get(value, method) !== "function"
    )
      diagnostics.push({ code: "QUEUE_BINDING_MISSING", name: name ?? "" });
  }
  const reader = cloudflareSecrets(env);
  const required = new Map<string, string | undefined>();
  for (const name of form.guards?.flatMap((guard) => [
    ...(guard.secretNames ?? []),
  ]) ?? [])
    required.set(name, undefined);
  for (const destinationId of form.destinations)
    for (const name of secretNames(config.destinations[destinationId]))
      required.set(name, destinationId);
  for (const [name, destinationId] of required) {
    try {
      await reader.read(name);
    } catch {
      diagnostics.push({
        code: "SECRET_MISSING",
        name,
        ...(destinationId ? { destinationId } : {}),
      });
    }
  }
  for (const name of new Set(
    form.guards?.flatMap((guard) => [...(guard.bindingNames ?? [])]),
  ))
    if (!binding(env, name))
      diagnostics.push({ code: "GUARD_BINDING_MISSING", name });
  for (const type of new Set(
    form.destinations.map(
      (destinationId) => config.destinations[destinationId]?.provider,
    ),
  )) {
    if (!type) continue;
    try {
      config.providers
        .find((provider) => provider.type === type)
        ?.create(dependenciesFor(type));
    } catch {
      diagnostics.push({ code: "PROVIDER_DEPENDENCY_MISSING", name: type });
    }
  }
  return {
    id,
    destinations: form.destinations.map((destinationId) => ({
      id: destinationId,
      provider: config.destinations[destinationId]?.provider ?? "",
      revision: config.destinations[destinationId]?.revision ?? "",
    })),
    ready: diagnostics.length === 0,
    diagnostics,
  };
}
