import type { Guard, ProviderDefinition, Schema } from "../contracts/ports";
import type { RelayMessage, Submission } from "../domain/models";
import { identifierSchema, LIMITS, revisionSchema } from "../domain/validation";
import { ConfigurationError } from "../errors/safe-error";

// Type erasure is confined to registry storage. Public builders retain the full relationships.
export type AnyProvider = ProviderDefinition<string, any, any>;
export type DestinationFor<P extends readonly AnyProvider[]> =
  P[number] extends infer Item
    ? Item extends ProviderDefinition<infer K, infer C, any>
      ? C & { provider: K; revision: string }
      : never
    : never;
export type DestinationRegistry = Readonly<
  Record<
    string,
    { provider: string; revision: string } & Record<string, unknown>
  >
>;
type CheckedDestinations<
  P extends readonly AnyProvider[],
  D extends DestinationRegistry,
> = {
  [K in keyof D]: D[K] &
    Record<
      Exclude<
        keyof D[K],
        keyof Extract<DestinationFor<P>, { provider: D[K]["provider"] }>
      >,
      never
    > &
    (D[K]["revision"] extends "" ? never : unknown);
};
export interface FormDefinition<
  T,
  D extends readonly string[] = readonly string[],
  G extends readonly Guard[] = readonly Guard[],
  Unsafe extends boolean = boolean,
> {
  schema: Schema<T>;
  destinations: D;
  allowedOrigins?: readonly string[];
  guards?: G;
  unsafeAllowUnprotected?: Unsafe;
  message(submission: Submission<T>): RelayMessage;
}
export type AnyForm = FormDefinition<any>;
export interface RelayConfig<
  P extends readonly AnyProvider[] = readonly AnyProvider[],
  D extends DestinationRegistry = DestinationRegistry,
  F extends Record<string, AnyForm> = Record<string, AnyForm>,
> {
  providers: P;
  destinations: D;
  forms: F;
}
export type ProviderDependencies<P extends readonly AnyProvider[]> = {
  [Item in P[number] as Item["type"]]: Item extends ProviderDefinition<
    string,
    any,
    infer Deps
  >
    ? Deps
    : never;
};
export function defineProviders<const P extends readonly AnyProvider[]>(
  providers: P,
): P {
  const types = new Set<string>();
  for (const provider of providers) {
    if (!/^[a-z][a-z0-9-]*$/.test(provider.type) || types.has(provider.type))
      throw new ConfigurationError("Invalid or duplicate provider type");
    types.add(provider.type);
  }
  return Object.freeze(providers);
}
export function defineDestinations<
  const P extends readonly AnyProvider[],
  const D extends Record<string, DestinationFor<P>> & DestinationRegistry,
>(providers: P, destinations: D & CheckedDestinations<P, D>): D {
  return parseDestinations(providers, destinations) as D;
}
function parseDestinations(
  providers: readonly AnyProvider[],
  destinations: DestinationRegistry,
): DestinationRegistry {
  const result: Record<string, unknown> = Object.create(null);
  for (const [id, input] of Object.entries(
    destinations as DestinationRegistry,
  )) {
    if (
      !identifierSchema.safeParse(id).success ||
      !revisionSchema.safeParse(input.revision).success
    )
      throw new ConfigurationError("Invalid destination ID or revision");
    const provider = providers.find((item) => item.type === input.provider);
    if (!provider) throw new ConfigurationError("Unknown destination provider");
    const { provider: type, revision, ...config } = input;
    let parsed: object;
    try {
      parsed = provider.configSchema.parse(config);
    } catch {
      throw new ConfigurationError("Invalid destination configuration");
    }
    result[id] = deepFreeze({ ...parsed, provider: type, revision });
  }
  return Object.freeze(result) as DestinationRegistry;
}
// Entries retain duplicate IDs so callers constructing a registry programmatically can be checked.
export function defineDestinationEntries<
  const P extends readonly AnyProvider[],
  const Entries extends readonly (readonly [string, DestinationFor<P>])[],
>(
  providers: P,
  entries: Entries,
): { readonly [E in Entries[number] as E[0]]: E[1] } {
  const ids = new Set<string>();
  for (const [id] of entries) {
    if (ids.has(id)) throw new ConfigurationError("Duplicate destination ID");
    ids.add(id);
  }
  return parseDestinations(providers, Object.fromEntries(entries)) as {
    readonly [E in Entries[number] as E[0]]: E[1];
  };
}
export function defineForm<
  T,
  const D extends readonly string[],
  const G extends readonly Guard[] = readonly [],
  const Unsafe extends boolean = false,
>(form: FormDefinition<T, D, G, Unsafe>): FormDefinition<T, D, G, Unsafe> {
  return Object.freeze({
    ...form,
    destinations: Object.freeze([...form.destinations]) as unknown as D,
    ...(form.allowedOrigins
      ? { allowedOrigins: Object.freeze([...form.allowedOrigins]) }
      : {}),
    guards: Object.freeze(
      (form.guards ?? []).map((guard) =>
        Object.freeze({
          ...guard,
          type: guard.type,
          phase: guard.phase,
          check: guard.check.bind(guard),
          fields: Object.freeze([...guard.fields]),
          ...(guard.secretNames
            ? { secretNames: Object.freeze([...guard.secretNames]) }
            : {}),
          ...(guard.bindingNames
            ? { bindingNames: Object.freeze([...guard.bindingNames]) }
            : {}),
        }),
      ),
    ) as unknown as G,
  });
}
export function defineForms<
  const D extends DestinationRegistry,
  const F extends Record<string, AnyForm>,
>(
  destinations: D,
  forms: F & {
    [K in keyof F]: { destinations: readonly (keyof D & string)[] };
  },
): F {
  for (const [id, form] of Object.entries(forms)) {
    if (!identifierSchema.safeParse(id).success)
      throw new ConfigurationError("Invalid form ID");
    if (
      !form.destinations.length ||
      form.destinations.length > LIMITS.destinations ||
      new Set(form.destinations).size !== form.destinations.length
    )
      throw new ConfigurationError("Invalid or duplicate form destinations");
    for (const destination of form.destinations)
      if (!Object.hasOwn(destinations, destination))
        throw new ConfigurationError("Unknown form destination");
  }
  return Object.freeze({ ...forms });
}
export function defineRelay<
  const P extends readonly AnyProvider[],
  const D extends Record<string, DestinationFor<P>> & DestinationRegistry,
  const F extends Record<string, AnyForm>,
>(
  config: RelayConfig<P, D, F> & {
    forms: { [K in keyof F]: F[K] & EffectiveProtection<F[K]> };
  },
): RelayConfig<P, D, F> {
  const providers = defineProviders(config.providers);
  const destinations = parseDestinations(providers, config.destinations) as D;
  // Revalidate even when callers bypassed defineForms or supplied untyped input.
  for (const [id, form] of Object.entries(config.forms)) {
    defineForms(destinations, { [id]: form });
    if (
      form.unsafeAllowUnprotected !== undefined &&
      typeof form.unsafeAllowUnprotected !== "boolean"
    )
      throw new ConfigurationError("unsafeAllowUnprotected must be a boolean");
    const guardTypes = new Set(form.guards?.map((guard) => guard.type));
    if (
      form.unsafeAllowUnprotected !== true &&
      !guardTypes.has("api-key") &&
      !(guardTypes.has("rate-limit") && guardTypes.has("turnstile"))
    )
      throw new ConfigurationError(
        "Form requires API-key protection or rate-limit plus Turnstile; unsafeAllowUnprotected explicitly opts out",
      );
    for (const origin of form.allowedOrigins ?? []) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new ConfigurationError("Invalid allowed origin");
      }
      if (
        parsed.origin !== origin ||
        !["http:", "https:"].includes(parsed.protocol)
      )
        throw new ConfigurationError(
          "Allowed origins must be exact HTTP(S) origins",
        );
    }
    const fields = form.guards?.flatMap((guard) => [...guard.fields]) ?? [];
    if (
      new Set(fields).size !== fields.length ||
      fields.some((field) =>
        ["__proto__", "prototype", "constructor"].includes(field),
      )
    )
      throw new ConfigurationError("Duplicate or unsafe security fields");
  }
  return Object.freeze({
    providers,
    destinations,
    forms: Object.freeze(
      Object.fromEntries(
        Object.entries(config.forms).map(([id, form]) => [
          id,
          defineForm(form),
        ]),
      ),
    ) as F,
  });
}
type EffectiveProtection<F extends AnyForm> =
  true extends F["unsafeAllowUnprotected"]
    ? unknown
    : "api-key" extends NonNullable<F["guards"]>[number]["type"]
      ? unknown
      : "rate-limit" extends NonNullable<F["guards"]>[number]["type"]
        ? "turnstile" extends NonNullable<F["guards"]>[number]["type"]
          ? unknown
          : never
        : never;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
