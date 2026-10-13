import { parseEnv } from "node:util";
import {
  boundedResponseText,
  type HttpClient,
  identifierSchema,
  revisionSchema,
} from "@cf-relay/core";
import { z } from "zod";
import { credentialContent } from "./credentials";
import { ToolError } from "./errors";
import { preview, readFixture } from "./preview";
import type { Project } from "./project";

const httpClient: HttpClient = { fetch: (input, init) => fetch(input, init) };
const readinessSchema = z.object({
  ready: z.boolean(),
  forms: z
    .array(
      z.object({
        id: identifierSchema,
        destinations: z.array(
          z.object({
            id: identifierSchema,
            provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            revision: revisionSchema,
          }),
        ),
        ready: z.boolean(),
        diagnostics: z.array(
          z.object({
            code: z.enum([
              "QUEUE_BINDING_MISSING",
              "SECRET_MISSING",
              "GUARD_BINDING_MISSING",
              "PROVIDER_DEPENDENCY_MISSING",
            ]),
            name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,255}$/),
            destinationId: identifierSchema.optional(),
          }),
        ),
      }),
    )
    .min(1),
});

function endpointUrl(endpoint: string, path: string) {
  try {
    const base = new URL(endpoint);
    if (
      base.username ||
      base.password ||
      base.hash ||
      base.search ||
      (base.protocol !== "https:" &&
        !(
          base.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
        ))
    )
      throw new Error();
    return new URL(path, base);
  } catch {
    throw new ToolError(
      "Use an HTTPS Worker endpoint, or HTTP on localhost for development, without URL credentials, query, or fragment.",
    );
  }
}
async function apiKey(project: Project) {
  const key =
    process.env.RELAY_API_KEY ||
    parseEnv((await credentialContent(project)).content).SERVER_API_KEY;
  if (!key || /[\r\n\0]/.test(key) || key.length > 4089)
    throw new ToolError(
      "Set RELAY_API_KEY or local SERVER_API_KEY for the readiness check. Credentials are never accepted as command-line arguments.",
    );
  return key;
}

export async function remoteDoctor(
  project: Project,
  endpoint: string,
  requestedForm?: string,
  http: HttpClient = httpClient,
) {
  const url = endpointUrl(endpoint, "/v1/readiness");
  const key = await apiKey(project);
  const signal = AbortSignal.timeout(5000);
  let response: Response;
  try {
    response = await http.fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      redirect: "error",
      signal,
    });
  } catch {
    throw new ToolError(
      "Cannot reach Worker readiness. Check the endpoint and network.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new ToolError(
      "Readiness authentication failed. Check the operator API key.",
    );
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new ToolError(
      "Worker does not expose readiness. Deploy an entry point with readinessGuard.",
    );
  }
  if (![200, 503].includes(response.status)) {
    await response.body?.cancel();
    throw new ToolError(`Readiness returned HTTP ${response.status}.`);
  }
  let report: z.infer<typeof readinessSchema>;
  try {
    report = readinessSchema.parse(
      JSON.parse(await boundedResponseText(response, 65536, signal)),
    );
  } catch {
    throw new ToolError(
      "Worker returned an invalid or unavailable readiness report.",
    );
  }
  const ids = requestedForm
    ? [requestedForm]
    : Object.keys(project.config.forms);
  const forms = ids.map((id) => {
    const form = report.forms.find((item) => item.id === id);
    const local = project.config.forms[id];
    if (!form || !local)
      throw new ToolError(
        "Choose a form configured both locally and on the deployed Worker.",
      );
    const expected = local.destinations.map((destinationId) => ({
      id: destinationId,
      provider: project.config.destinations[destinationId]?.provider,
      revision: project.config.destinations[destinationId]?.revision,
    }));
    const canonical = (
      destinations: readonly {
        id: string;
        provider?: string | undefined;
        revision?: string | undefined;
      }[],
    ) =>
      JSON.stringify(
        [...destinations].sort((a, b) => a.id.localeCompare(b.id)),
      );
    if (canonical(expected) !== canonical(form.destinations))
      throw new ToolError(
        "Deployed destination IDs, providers, or revisions differ from local configuration. Deploy the intended configuration before testing.",
      );
    return form;
  });
  return {
    ready:
      forms.length > 0 &&
      forms.every((form) => form.ready && form.diagnostics.length === 0),
    forms,
    note: "Configuration presence only. Credentials, provider acceptance, and sender DNS are not verified.",
  };
}

export async function sendTest(
  project: Project,
  options: {
    endpoint?: string | undefined;
    input?: string | undefined;
    form?: string | undefined;
    origin?: string | undefined;
    live?: boolean | undefined;
  },
  http: HttpClient = httpClient,
) {
  const rendered = await preview(
    project,
    options.input ?? project.fixturePath,
    options.form,
    options.origin,
  );
  if (rendered.errors.length)
    throw new ToolError(
      "Preview failed. Fix the selected destination payloads before sending.",
    );
  if (!options.live) return { mode: "preview" as const, ...rendered };
  if (!options.endpoint)
    throw new ToolError("Supply --endpoint for an explicit --live submission.");
  const report = await remoteDoctor(
    project,
    options.endpoint,
    rendered.formId,
    http,
  );
  if (!report.ready)
    throw new ToolError(
      `Worker is not ready: ${report.forms.flatMap((form) => form.diagnostics.map((item) => `${item.code}: ${item.name}`)).join(", ")}.`,
    );
  const body = await readFixture(options.input ?? project.fixturePath);
  const url = endpointUrl(
    options.endpoint,
    `/v1/forms/${encodeURIComponent(rendered.formId)}`,
  );
  const key = await apiKey(project);
  const signal = AbortSignal.timeout(10000);
  let response: Response;
  try {
    response = await http.fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(options.origin ? { origin: options.origin } : {}),
      },
      signal,
      redirect: "error",
    });
  } catch {
    throw new ToolError(
      "Submission acceptance is unconfirmed. Do not automatically retry; inspect Worker logs and the destination.",
    );
  }
  if (response.status === 503) {
    await response.body?.cancel();
    throw new ToolError(
      "Submission acceptance is unconfirmed (503). Do not automatically retry; inspect Worker logs and the destination.",
    );
  }
  if (response.status !== 202) {
    await response.body?.cancel();
    throw new ToolError(
      `Submission rejected (HTTP ${response.status}). No automatic retry was attempted.`,
    );
  }
  try {
    const result = z
      .object({
        id: z.string().regex(/^sub_[a-zA-Z0-9_-]{1,128}$/),
        status: z.literal("queued"),
        destinations: z.number().int().min(1).max(10),
      })
      .parse(JSON.parse(await boundedResponseText(response, 4096, signal)));
    return {
      mode: "live" as const,
      ...result,
      note: "Queue acceptance confirmed. Downstream delivery is asynchronous; verify receipt at the destination.",
    };
  } catch {
    throw new ToolError(
      "Worker returned an unexpected acceptance response. Do not automatically retry; inspect Worker logs.",
    );
  }
}
