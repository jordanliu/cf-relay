# Deployment and operations

The repository's CI builds and tests source only. Deploying a Worker, creating Queues, configuring credentials, and sending notifications require a later explicit deployment decision in your own Cloudflare account. No such resources or credentials are included in this release.

## Configure and deploy later

1. Log in using Wrangler and select the intended account. Rename the Worker/Queues if these names already exist.
2. Edit `apps/worker/relay.config.ts`: forms, business schemas, rendered fields, configured destinations, secret binding names, and required revisions. Remove unused destinations and forms. Public forms require rate limit plus Turnstile. API keys belong only in server clients. Exact-origin CORS is browser policy, not authentication.
3. Edit `apps/worker/wrangler.jsonc`: exact email sender/recipient allowlists, and an account-unique rate-limit `namespace_id`. Reusing an ID shares counters between Workers. Rate limiting is a distributed anti-abuse aid, not a precise global quota or per-destination delivery scheduler. `CF-Connecting-IP` is trusted only when requests reach this Worker through Cloudflare; local or alternate-runtime adapters must provide a trusted actor identity. IP hashes are used transiently as limiter keys and not placed in jobs/logs.
4. Create a Turnstile widget for your browser hostname and use its public site key in your HTML. Set `expectedHostname` and optionally `expectedAction` to the exact expected verification result. Store `TURNSTILE_SECRET` using Wrangler secrets. No token is queued or logged.
5. Create both Queues. Choose retention deliberately using the supported CLI/API options for your plan, and configure alerts before accepting production submissions.

```sh
npx wrangler queues create cf-relay-deliveries
npx wrangler queues create cf-relay-failures
npx wrangler secret put ENGINEERING_SLACK_WEBHOOK_V1 --config apps/worker/wrangler.jsonc
npx wrangler secret put COMMUNITY_DISCORD_WEBHOOK_V1 --config apps/worker/wrangler.jsonc
npx wrangler secret put TURNSTILE_SECRET --config apps/worker/wrangler.jsonc
npx wrangler secret put SERVER_API_KEY --config apps/worker/wrangler.jsonc
```

Use interactive prompts; never commit credentials, pass them in command arguments, or print them in logs. The local `.dev.vars` file is ignored. Static generated types know platform binding names; secret names are declared separately in the composition root because cloud values are unavailable to static tooling.

6. Onboard the sender domain for Cloudflare Email Service and configure its DNS/authentication requirements. Restrict senders and recipients in the binding. The native transport uses the current structured `SendEmail.send()` API and validates the returned `messageId`. A native API error is classified by its safe string code. Domain onboarding and delivery success cannot be proved by an offline build. See [Cloudflare email setup](https://developers.cloudflare.com/email-service/get-started/send-emails/) and [binding restrictions](https://developers.cloudflare.com/email-service/configuration/send-bindings/).
7. Run checks and regenerate bindings after changing Wrangler config. This validates configuration/schema names but cannot read or verify live secret values. The HTTP path checks required selected-form secret/binding availability before publication; Queue dispatch fails closed when capabilities are unavailable.

```sh
npm run types:generate
npm run check
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

The final command deploys live resources; use it only when ready. Bind a custom domain/route and update browser form origins and endpoint URLs. Perform a controlled provider delivery check after deployment using recipients you own; offline tests do not establish provider delivery.

## Revision changes and draining

Every destination revision must change when recipient/endpoint identity changes, including a credential value behind the same binding name. Prefer a new ID and secret name when changing audience/workspace. IDs, provider types, and revisions in jobs must match the current registry before secrets are resolved or delivery starts.

To preserve pending old-target deliveries, stop incoming submissions, monitor the delivery backlog and in-flight attempts until drained, then change config/credentials and revision together. Alternatively keep explicit old and new destination IDs active until old jobs drain. This release has no historical destination store or automatic migration. Removing or rotating a destination while old jobs remain produces `DESTINATION_REVISION_MISMATCH`; the dispatcher records a sanitized terminal failure before acknowledging. Rotating a secret value without a revision bump violates the deployment contract and cannot be detected by symbolic references.

## Retry budgets and uncertain acceptance

The example consumer uses five retries, batches of ten, five-second batch waits, and a concurrency cap of ten. Each message uses `message.attempts`, not a counter in the job. Delay is a positive integer capped at one hour by cf-relay and 24 hours by the platform. Upstream `Retry-After` hints are bounded. This is not a per-destination throttle; all destinations share the consumer.

Queue publication and failure-record writes have five-second wait deadlines. Provider attempts have ten-second deadlines; guards and raw-body reading have five-second limits. HTTP sends receive an AbortSignal and redirects are disabled. Native Cloudflare email and Queue writes do not expose cancellation; work may be accepted after a deadline. Retained promises protect event lifetime where possible, without implying zero effect. A retry may duplicate a provider send or a failure record. Resend is used without a durable idempotency promise.

## Monitor and inspect failures

Use `wrangler tail --config apps/worker/wrangler.jsonc` or Workers Logs for redacted event codes and correlation IDs. Monitor both Queue backlog and oldest-message age. Alert on nonzero failure backlog and approaching retention; errors can otherwise expire unnoticed. Core events include submission rejection/queued/publication uncertainty, delivery start/acceptance/retry/permanent failure/revision mismatch, and failure-sink errors. Logger fields are allowlisted; raw bodies, addresses, tokens, endpoint URLs, external response bodies, and Error messages are omitted.

The shared `cf-relay-failures` Queue is both a sanitized failure producer target and the platform DLQ. Discriminate by `kind` and `version`:

| Envelope | Meaning | Contains rendered content? |
| --- | --- | --- |
| `failure.record`, version 1 | Dispatcher terminal/invalid-job record | No |
| `delivery`, version 1 | Original job exhausted platform retries | Yes, may contain PII |
| Anything else | Malformed/unsupported original exhausted retries | Unknown; treat as sensitive |

Use the authenticated [Queue messages peek API](https://developers.cloudflare.com/api/typescript/resources/queues/subresources/messages/methods/peek/) to inspect without leasing or consuming. Current accepted permissions are **Queues Write or Workers Scripts Write**, even for peek; restrict token scope to the account and operators who need access. Avoid poll/ack endpoints for read-only investigation.

```text
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/queues/{queue_id}/messages/peek
Authorization: Bearer <operator-token>
Content-Type: application/json

{"batch_size":1}
```

Do not paste returned envelopes into public issues or analytics. `failureEnvelopeSchema.safeParse()` recognizes known shapes but must not cause unknown shapes to be printed or blindly replayed. Resolve the underlying cause, then explicitly decide whether to re-submit. Re-submission can duplicate notifications or change audience. There is no replay API/UI in v1.

## Retention and limits

No application database does not mean no storage: Queues retain rendered messages until accepted, expired, or moved to the DLQ. Sanitized terminal records and original exhausted jobs share retention. Default retention is four days on eligible paid plans; Free plan retention is limited to 24 hours. Configure supported retention values and export sanitized incident metadata to approved external observability if longer history is needed. Inspect current plan limits before deployment; an unconsumed DLQ is not permanent storage.

References checked during implementation: [Queue limits](https://developers.cloudflare.com/queues/platform/limits/), [JavaScript settlement APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/), [batching/retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), [DLQs](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), [concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/), [rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), and [native email API/error codes](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
