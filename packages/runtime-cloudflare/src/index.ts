import {
  type AnyProvider,
  type DestinationFor,
  type DestinationRegistry,
  defineRelay,
  type Guard,
  ingest,
  type ProviderDependencies,
  type RelayConfig,
  RelayError,
  unavailable,
  withDeadline,
} from "@cf-relay/core";
import { Hono } from "hono";
import {
  binding,
  cloudflareSecrets,
  createSafeLogger,
  runtimeHttp,
} from "./capabilities";
import { cloudflareFailureSink } from "./failure-sink";
import { parseBody } from "./http";
import { cloudflareRateLimit } from "./limits";
import { cloudflarePublisher, consumeQueue } from "./queue";
import { checkFormReadiness, type ReadinessReport } from "./readiness";

export * from "./capabilities";
export * from "./failure-sink";
export * from "./http";
export * from "./limits";
export * from "./queue";
export * from "./readiness";

export type ProviderDependencyFactories<
  E extends object,
  P extends readonly AnyProvider[],
> = {
  [K in keyof ProviderDependencies<P> as ProviderDependencies<P>[K] extends Record<
    string,
    never
  >
    ? never
    : K]: (env: E) => ProviderDependencies<P>[K];
} & {
  [K in keyof ProviderDependencies<P> as ProviderDependencies<P>[K] extends Record<
    string,
    never
  >
    ? K
    : never]?: (env: E) => ProviderDependencies<P>[K];
};

export function createCloudflareRelay<
  E extends object,
  const P extends readonly AnyProvider[],
  const D extends DestinationRegistry & Record<string, DestinationFor<P>>,
>(
  declaredConfig: RelayConfig<P, D>,
  options: {
    readinessGuard?: (Guard & { readonly type: "api-key" }) | undefined;
    providerDependencies: ProviderDependencyFactories<E, P> &
      Record<string, (env: E) => object>;
  },
) {
  // The composition root already uses defineRelay. Revalidation also protects untyped consumers.
  const config: RelayConfig<P, D> = defineRelay(declaredConfig);
  const dependenciesFor = (env: E, type: string): object => {
    const factories = options.providerDependencies as Record<
      string,
      ((env: E) => object) | undefined
    >;
    return Object.hasOwn(factories, type) ? (factories[type]?.(env) ?? {}) : {};
  };
  const app = new Hono<{ Bindings: E }>();
  const logger = createSafeLogger();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  if (options.readinessGuard) {
    const guard = options.readinessGuard;
    if (
      guard.type !== "api-key" ||
      guard.phase !== "auth" ||
      guard.fields.length
    )
      throw new Error("Readiness requires an API-key guard");
    const check = guard.check.bind(guard);
    app.get("/v1/readiness", async (c) => {
      c.header("cache-control", "no-store");
      c.header("x-content-type-options", "nosniff");
      try {
        const result = await withDeadline(
          (signal) =>
            check(
              {
                formId: "readiness",
                security: {},
                headers: { authorization: c.req.header("authorization") ?? "" },
              },
              {
                http: runtimeHttp,
                secretReader: cloudflareSecrets(c.env),
                signal,
                rateLimit: (name, key) => cloudflareRateLimit(c.env, name, key),
              },
            ),
          5000,
          c.req.raw.signal,
        );
        if (!result.allowed)
          return c.json(
            {
              error: {
                code:
                  result.status === 401
                    ? "UNAUTHORIZED"
                    : "SERVICE_UNAVAILABLE",
                message: "Readiness check was not authorized.",
              },
            },
            result.status,
          );
        const forms = [];
        for (const id of Object.keys(config.forms))
          forms.push(
            await checkFormReadiness(config, id, c.env, (type) =>
              dependenciesFor(c.env, type),
            ),
          );
        const report: ReadinessReport = {
          ready: forms.length > 0 && forms.every((form) => form.ready),
          forms,
        };
        return c.json(report, report.ready ? 200 : 503);
      } catch {
        return c.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Readiness check unavailable.",
            },
          },
          503,
        );
      }
    });
  }
  app.all("/v1/forms/:formId", async (c) => {
    const formId = c.req.param("formId");
    const form = Object.hasOwn(config.forms, formId)
      ? config.forms[formId]
      : undefined;
    const origin = c.req.header("origin");
    const cors = new Headers({
      vary: "Origin",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const respond = (data: unknown, status: number) =>
      new Response(JSON.stringify(data), {
        status,
        headers: new Headers({
          ...Object.fromEntries(cors),
          "content-type": "application/json",
        }),
      });
    try {
      if (!form)
        throw new RelayError(404, "FORM_NOT_FOUND", "Form not configured.");
      if (origin && !form.allowedOrigins?.includes(origin))
        throw new RelayError(
          403,
          "ACCESS_DENIED",
          "Submission was not accepted.",
        );
      if (origin) cors.set("access-control-allow-origin", origin);
      if (c.req.method === "OPTIONS") {
        const method = c.req.header("access-control-request-method");
        const headers =
          c.req
            .header("access-control-request-headers")
            ?.toLowerCase()
            .split(",")
            .map((header) => header.trim()) ?? [];
        if (
          !origin ||
          method !== "POST" ||
          headers.some(
            (header) => !["content-type", "authorization"].includes(header),
          )
        )
          throw new RelayError(
            403,
            "ACCESS_DENIED",
            "Submission was not accepted.",
          );
        cors.set("access-control-allow-methods", "POST");
        cors.set("access-control-allow-headers", "Content-Type, Authorization");
        return new Response(null, { status: 204, headers: cors });
      }
      if (c.req.method !== "POST") {
        cors.set("allow", "POST, OPTIONS");
        throw new RelayError(405, "METHOD_NOT_ALLOWED", "Use POST.");
      }
      const queue = binding(c.env, "DELIVERIES");
      const readiness = await checkFormReadiness(
        config,
        formId,
        c.env,
        (type) => dependenciesFor(c.env, type),
      );
      if (!readiness.ready) throw unavailable();
      const secrets = cloudflareSecrets(c.env);
      const body = await parseBody(c.req.raw);
      const clientIp = c.req.header("cf-connecting-ip");
      const result = await ingest(
        config,
        {
          formId,
          body,
          headers: { authorization: c.req.header("authorization") ?? "" },
          ...(origin ? { origin } : {}),
          ...(clientIp ? { clientIp } : {}),
        },
        {
          http: runtimeHttp,
          logger,
          secretReader: secrets,
          signal: c.req.raw.signal,
          rateLimit: (name, key) => cloudflareRateLimit(c.env, name, key),
          publisher: cloudflarePublisher(queue as Queue, 5000, (pending) =>
            c.executionCtx.waitUntil(pending),
          ),
        },
      );
      return respond(result, 202);
    } catch (error) {
      const safe = error instanceof RelayError ? error : unavailable();
      logger.warn("submission.rejected", { code: safe.code });
      return respond(
        { error: { code: safe.code, message: safe.message } },
        safe.status,
      );
    }
  });
  app.notFound((c) =>
    c.json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404),
  );
  app.onError((_error, c) =>
    c.json(
      {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Submission service is unavailable.",
        },
      },
      503,
    ),
  );
  return {
    handleRequest: (request: Request, env: E, ctx: ExecutionContext) =>
      app.fetch(request, env, ctx),
    async handleQueue(
      batch: MessageBatch<unknown>,
      env: E,
      ctx: ExecutionContext,
    ): Promise<void> {
      const failures = binding(env, "FAILURES");
      const failureSink =
        failures &&
        typeof failures === "object" &&
        "send" in failures &&
        typeof failures.send === "function"
          ? cloudflareFailureSink(failures as Queue, 5000, (pending) =>
              ctx.waitUntil(pending),
            )
          : {
              async record() {
                throw new Error("Failure binding unavailable");
              },
            };
      await consumeQueue(config, batch, {
        http: runtimeHttp,
        logger,
        secretReader: cloudflareSecrets(env),
        dependencies: {},
        getDependencies: (type) => dependenciesFor(env, type),
        failureSink,
      });
    },
  };
}
