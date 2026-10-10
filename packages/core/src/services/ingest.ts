import type { AnyForm, RelayConfig } from "../config/registry";
import type {
  GuardCapabilities,
  GuardInput,
  GuardResult,
  JobPublisher,
  Logger,
} from "../contracts/ports";
import type { DeliveryJob, RelayMessage, Submission } from "../domain/models";
import { encodedBytes, LIMITS, validateMessage } from "../domain/validation";
import { invalidMessage, RelayError, unavailable } from "../errors/safe-error";
import { withDeadline } from "./deadline";

export interface IngressInput {
  formId: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  origin?: string;
  clientIp?: string;
}
const phaseOrder = { rate: 0, auth: 1, bot: 2 };
export async function ingest(
  config: RelayConfig,
  input: IngressInput,
  capabilities: GuardCapabilities & { publisher: JobPublisher; logger: Logger },
): Promise<{ id: string; status: "queued"; destinations: number }> {
  const form: AnyForm | undefined = Object.hasOwn(config.forms, input.formId)
    ? config.forms[input.formId]
    : undefined;
  if (!form)
    throw new RelayError(404, "FORM_NOT_FOUND", "Form not configured.");
  const data: Record<string, unknown> = Object.create(null);
  const security: Record<string, unknown> = Object.create(null);
  const fields = new Set(form.guards?.flatMap((guard) => [...guard.fields]));
  for (const [key, value] of Object.entries(input.body))
    (fields.has(key) ? security : data)[key] = value;
  const guardInput: GuardInput = {
    formId: input.formId,
    security,
    headers: input.headers,
    ...(input.clientIp ? { clientIp: input.clientIp } : {}),
  };
  for (const guard of [...(form.guards ?? [])].sort(
    (a, b) => phaseOrder[a.phase] - phaseOrder[b.phase],
  )) {
    let result: GuardResult;
    try {
      result = await withDeadline(
        (signal) => guard.check(guardInput, { ...capabilities, signal }),
        5000,
        capabilities.signal,
      );
    } catch {
      throw unavailable();
    }
    if (!result.allowed) {
      const code =
        result.status === 401
          ? "UNAUTHORIZED"
          : result.status === 429
            ? "RATE_LIMITED"
            : result.status === 503
              ? "SERVICE_UNAVAILABLE"
              : "ACCESS_DENIED";
      throw new RelayError(result.status, code, "Submission was not accepted.");
    }
  }
  let parsed: unknown;
  try {
    parsed = form.schema.parse(data);
  } catch {
    throw new RelayError(422, "INVALID_FIELDS", "Business fields are invalid.");
  }
  const submission: Submission<unknown> = {
    id: `sub_${crypto.randomUUID()}`,
    formId: input.formId,
    createdAt: new Date().toISOString(),
    data: parsed,
    metadata: input.origin ? { origin: input.origin } : {},
  };
  let message: RelayMessage;
  try {
    message = validateMessage(form.message(submission));
  } catch {
    throw invalidMessage();
  }
  const jobs: DeliveryJob[] = form.destinations.map((id) => {
    const destination = config.destinations[id];
    if (!destination) throw unavailable();
    return {
      kind: "delivery",
      version: 1,
      deliveryId: `${submission.id}:${id}`,
      submissionId: submission.id,
      formId: input.formId,
      createdAt: submission.createdAt,
      destination: {
        id,
        provider: destination.provider,
        revision: destination.revision,
      },
      message,
    };
  });
  if (
    jobs.some((job) => encodedBytes(job) > LIMITS.jobBytes) ||
    encodedBytes(jobs) > LIMITS.batchBytes
  )
    throw invalidMessage();
  try {
    await capabilities.publisher.publish(jobs);
  } catch {
    capabilities.logger.warn("submission.publish_uncertain", {
      submissionId: submission.id,
      formId: input.formId,
      code: "ACCEPTANCE_UNKNOWN",
    });
    throw new RelayError(
      503,
      "QUEUE_UNAVAILABLE",
      "Submission could not be confirmed. Retrying may duplicate notifications.",
    );
  }
  capabilities.logger.info("submission.queued", {
    submissionId: submission.id,
    formId: input.formId,
    destinations: jobs.length,
  });
  return { id: submission.id, status: "queued", destinations: jobs.length };
}
