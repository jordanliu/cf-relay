import { z } from "zod";
import { ToolError } from "./errors";

export const providerTypes = ["slack", "discord", "email", "webhook"] as const;
export type ProviderType = (typeof providerTypes)[number];
export interface ProviderOptions {
  provider?: string | undefined;
  providers?: string | undefined;
  "email-transport"?: string | undefined;
  "webhook-auth"?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}
export function selectedProviders(options: ProviderOptions): ProviderType[] {
  if (options.provider !== undefined && options.providers !== undefined)
    throw new ToolError("Use either --provider or --providers, not both.");
  if (options.provider?.includes(","))
    throw new ToolError(
      "--provider accepts one provider. Use --providers for a comma-separated selection.",
    );
  const values = (options.providers ?? options.provider ?? "")
    .split(",")
    .map((value) => value.trim());
  if (
    !values.length ||
    values.some((value) => !providerTypes.includes(value as ProviderType)) ||
    new Set(values).size !== values.length
  )
    throw new ToolError(
      "Choose one or more distinct providers: slack, discord, email, webhook.",
    );
  return values as ProviderType[];
}
export function providerSettings(
  options: ProviderOptions,
  selected: readonly ProviderType[],
) {
  const transport = options["email-transport"] ?? "cloudflare";
  if (
    !["cloudflare", "resend", "smtp"].includes(transport) ||
    (options["email-transport"] && !selected.includes("email"))
  )
    throw new ToolError(
      "--email-transport requires email and must be cloudflare, resend, or smtp.",
    );
  const auth = options["webhook-auth"] ?? "signing";
  if (
    !["signing", "bearer", "both", "none"].includes(auth) ||
    (options["webhook-auth"] && !selected.includes("webhook"))
  )
    throw new ToolError(
      "--webhook-auth requires webhook and must be signing, bearer, both, or none.",
    );
  const from = options.from ?? "forms@example.com";
  const to = (options.to ?? "team@example.com")
    .split(",")
    .map((value) => value.trim());
  if (
    selected.includes("email") &&
    (!z.email().safeParse(from).success ||
      !z.array(z.email()).min(1).max(50).safeParse(to).success)
  )
    throw new ToolError("Supply valid email addresses with --from and --to.");
  return { transport, auth, from, to };
}
export function destinationSource(
  provider: ProviderType,
  settings: ReturnType<typeof providerSettings>,
  prefix = "",
) {
  const ref = (suffix: string) =>
    `secret(${JSON.stringify(`${prefix}${suffix}`)})`;
  const properties =
    provider === "email"
      ? `from: ${JSON.stringify(settings.from)}, to: ${JSON.stringify(settings.to)},`
      : provider === "webhook"
        ? `url: ${ref("WEBHOOK_URL_V1")}, ${["signing", "both"].includes(settings.auth) ? `signingSecret: ${ref("WEBHOOK_SIGNING_SECRET_V1")},` : ""} ${["bearer", "both"].includes(settings.auth) ? `bearerToken: ${ref("WEBHOOK_BEARER_TOKEN_V1")},` : ""}`
        : `webhook: ${ref(`${provider.toUpperCase()}_WEBHOOK_V1`)},`;
  return `{ provider: ${JSON.stringify(provider)}, revision: "v1", ${properties} }`;
}
export function providerSecrets(
  provider: ProviderType,
  settings: ReturnType<typeof providerSettings>,
) {
  if (provider === "email")
    return settings.transport === "resend"
      ? ["RESEND_API_KEY"]
      : settings.transport === "smtp"
        ? ["SMTP_URL"]
        : [];
  if (provider === "webhook")
    return [
      "WEBHOOK_URL_V1",
      ...(["signing", "both"].includes(settings.auth)
        ? ["WEBHOOK_SIGNING_SECRET_V1"]
        : []),
      ...(["bearer", "both"].includes(settings.auth)
        ? ["WEBHOOK_BEARER_TOKEN_V1"]
        : []),
    ];
  return [`${provider.toUpperCase()}_WEBHOOK_V1`];
}

export function emailTransportCall(transport: string) {
  const binding =
    transport === "cloudflare"
      ? "EMAIL"
      : transport === "resend"
        ? "RESEND_API_KEY"
        : "SMTP_URL";
  return `${transport}EmailTransport(env.${binding})`;
}
