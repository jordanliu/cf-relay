import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import {
  encodedBytes,
  LIMITS,
  type RelayMessage,
  validateMessage,
} from "@cf-relay/core";
import { renderDiscord } from "@cf-relay/provider-discord";
import {
  emailConfigSchema,
  escapeHtml,
  renderEmail,
} from "@cf-relay/provider-email";
import { renderSlack } from "@cf-relay/provider-slack";
import { ToolError } from "./errors";
import type { Project } from "./project";

type Preview = {
  destinationId: string;
  provider: string;
  revision: string;
  payload: unknown;
};
type PreviewError = { destinationId: string; code: string; message: string };

export async function preview(
  project: Project,
  input?: string,
  requestedForm?: string,
  origin?: string,
) {
  if (!input) throw new ToolError("Supply a JSON fixture with --input path.");
  const ids = Object.keys(project.config.forms);
  const formId = requestedForm ?? (ids.length === 1 ? ids[0] : undefined);
  if (!formId || !Object.hasOwn(project.config.forms, formId))
    throw new ToolError("Choose a configured form with --form formId.");
  const form = project.config.forms[formId];
  if (!form) throw new ToolError("Form is not configured.");
  if (origin) {
    try {
      if (new URL(origin).origin !== origin) throw new Error();
    } catch {
      throw new ToolError(
        "--origin must be an exact HTTP(S) origin without a path.",
      );
    }
    if (!/^https?:\/\//.test(origin))
      throw new ToolError("--origin must use HTTP(S).");
  }
  let body: unknown;
  try {
    const file = await open(input, "r");
    try {
      const bytes = Buffer.alloc(LIMITS.rawBodyBytes + 1);
      const { bytesRead } = await file.read(bytes);
      if (bytesRead > LIMITS.rawBodyBytes)
        throw new ToolError("Fixture exceeds the 32 KiB request body limit.");
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, bytesRead),
        ),
      );
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      "Cannot read a UTF-8 JSON fixture. Check --input and its JSON syntax.",
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ToolError("Fixture must be a JSON object of submission fields.");
  const guardFields = new Set(
    form.guards?.flatMap((guard) => [...guard.fields]),
  );
  const data: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(body))
    if (!guardFields.has(key)) data[key] = value;
  let parsed: unknown;
  try {
    parsed = form.schema.parse(data);
  } catch {
    throw new ToolError(
      "Fixture fields do not match the form schema. Check required fields, types, and limits.",
    );
  }
  const submission = {
    id: `sub_${randomUUID()}`,
    formId,
    createdAt: new Date().toISOString(),
    data: parsed,
    metadata: origin ? { origin } : {},
  };
  let message: RelayMessage;
  try {
    message = validateMessage(form.message(submission));
  } catch {
    throw new ToolError(
      "The message transform failed or exceeded relay message limits. Check the form's message function.",
    );
  }
  const jobs = form.destinations.map((id) => ({
    kind: "delivery",
    version: 1,
    deliveryId: `${submission.id}:${id}`,
    submissionId: submission.id,
    formId,
    createdAt: submission.createdAt,
    destination: {
      id,
      provider: project.config.destinations[id]?.provider,
      revision: project.config.destinations[id]?.revision,
    },
    message,
  }));
  if (
    jobs.some((job) => encodedBytes(job) > LIMITS.jobBytes) ||
    encodedBytes(jobs) > LIMITS.batchBytes
  )
    throw new ToolError(
      "Rendered content exceeds the relay's serialized delivery job limits.",
    );
  const previews: Preview[] = [];
  const errors: PreviewError[] = [];
  for (const id of form.destinations) {
    const destination = project.config.destinations[id];
    if (!destination) throw new ToolError("Destination is not configured.");
    const { provider, revision } = destination;
    if (!["slack", "discord", "email"].includes(provider)) {
      errors.push({
        destinationId: id,
        code: "UNSUPPORTED_PREVIEW",
        message:
          "Preview supports built-in Slack, Discord, and email renderers.",
      });
      continue;
    }
    try {
      const payload =
        provider === "slack"
          ? renderSlack(message)
          : provider === "discord"
            ? renderDiscord(message)
            : renderEmail(
                message,
                emailConfigSchema.parse({
                  from: destination.from,
                  to: destination.to,
                }),
              );
      previews.push({ destinationId: id, provider, revision, payload });
    } catch {
      errors.push({
        destinationId: id,
        code: "INVALID_PAYLOAD",
        message:
          "This destination's rendered content or email headers exceed provider limits.",
      });
    }
  }
  return {
    formId,
    message,
    previews,
    errors,
    note: "Schema, message, serialized job, and built-in renderer checks only. Guards, credentials, network delivery, and provider acceptance are not exercised. Configuration and message transforms run as trusted local code.",
  };
}

export function previewHtml(
  report: Awaited<ReturnType<typeof preview>>,
): string {
  const json = (value: unknown) =>
    `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  const sections = report.previews
    .map(
      (item) =>
        `<section><h2>${escapeHtml(item.destinationId)} (${escapeHtml(item.provider)})</h2>${item.provider === "email" ? `<iframe title="Email preview" sandbox srcdoc="${escapeHtml((item.payload as { html: string }).html)}"></iframe>` : ""}${json(item.payload)}</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notification preview</title>
<style>body { max-width: 60rem; margin: 2rem auto; padding: 1rem; font: 1rem system-ui; } pre { white-space: pre-wrap; overflow-wrap: anywhere; } iframe { width: 100%; min-height: 20rem; border: 1px solid #888; } section { margin: 2rem 0; }</style></head>
<body><h1>${escapeHtml(report.formId)} notification preview</h1><p>${escapeHtml(report.note)}</p>${sections}${report.errors.length ? `<h2>Errors</h2>${json(report.errors)}` : ""}</body></html>\n`;
}
