# Deployment and operations

Deploy cf-relay into your Cloudflare account. The repository includes configuration and local tests; CI does not provision resources or credentials.

## Configure and deploy

### 1. Authenticate

Log in with Wrangler and select the intended Cloudflare account:

```sh
npx wrangler login
```

### 2. Configure the Worker

| File | Configuration |
| --- | --- |
| [relay.config.ts](../apps/worker/relay.config.ts) | Forms, input schemas, message transforms, destinations, secret references, and destination revisions |
| [wrangler.jsonc](../apps/worker/wrangler.jsonc) | Worker and Queue names, email allowlists, rate-limit namespace, and consumer settings |

Remove unused forms and destinations. Rename the Worker and Queues if the default names already exist in the account. Update all producer, consumer, and dead-letter Queue references together.

For a minimal configuration, generate a [single-form starter](../README.md#2-configure-forms-and-destinations). Run `npm run doctor -- --strict` after editing configuration to check required secret names, bindings, Queue wiring, email allowlists, and placeholders.

For native email delivery, set exact sender and recipient allowlists. Choose an account-unique rate-limit `namespace_id` unless shared counters are intentional. Bindings using the same namespace share counters across Workers for the same key; see the [rate-limit binding documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

### 3. Configure request protection

Public browser forms require rate limiting and Turnstile. Server forms use API keys. Exact-origin CORS is enforced separately and does not authenticate requests.

Create a Turnstile widget for the browser hostname and set its public site key in the HTML client. Configure `expectedHostname` and, when used, `expectedAction` to match verification results. Store `TURNSTILE_SECRET` as a Wrangler secret. Tokens are not queued or logged.

The rate limiter combines the form ID with a transient hash of the client IP. `CF-Connecting-IP` is trusted only for requests reaching the Worker through Cloudflare. Local or alternative runtime adapters must supply a trusted actor identity. IP hashes are not placed in jobs or logs. Rate limiting provides distributed abuse protection rather than an exact global quota or destination delivery schedule.

### 4. Create Queues and set secrets

Create both Queues using the names configured in Wrangler:

```sh
npx wrangler queues create cf-relay-deliveries
npx wrangler queues create cf-relay-failures
```

Configure retention for the selected plan and alerts before accepting production submissions. See [retention and limits](#retention-and-limits).

The default forms use these secrets:

| Secret binding | Used by |
| --- | --- |
| `ENGINEERING_SLACK_WEBHOOK_V1` | Slack destination for `contact` and `events` |
| `COMMUNITY_DISCORD_WEBHOOK_V1` | Discord destination for `contact` |
| `TURNSTILE_SECRET` | Turnstile guard for `contact` |
| `SERVER_API_KEY` | API-key guard for `events` |

Set the secrets required by the retained forms and destinations:

```sh
npx wrangler secret put ENGINEERING_SLACK_WEBHOOK_V1 --config apps/worker/wrangler.jsonc
npx wrangler secret put COMMUNITY_DISCORD_WEBHOOK_V1 --config apps/worker/wrangler.jsonc
npx wrangler secret put TURNSTILE_SECRET --config apps/worker/wrangler.jsonc
npx wrangler secret put SERVER_API_KEY --config apps/worker/wrangler.jsonc
```

Use interactive prompts. Do not commit credentials, pass values in command arguments, or print them in logs. For local development, copy [the secret template](../apps/worker/.dev.vars.example) to `apps/worker/.dev.vars`; this file is ignored by Git.

Run `npm run doctor -- --local` to check local credential presence without printing values. Generated starters use their own `.dev.vars.example` and report the secret names required by the selected profile. Doctor does not inspect deployed secret values or validate credentials with providers.

Generated types describe platform bindings. Declare secret names separately in `WorkerEnv` in [the Worker entry point](../apps/worker/src/index.ts); static tooling cannot read live credential values.

### 5. Configure email, when used

For Cloudflare Email Service, onboard the sending domain and configure its DNS and authentication requirements. Restrict senders and recipients in the `EMAIL` binding. Follow [Cloudflare email setup](https://developers.cloudflare.com/email-service/get-started/send-emails/) and [binding restrictions](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

The native transport calls `SendEmail.send()`, validates the returned `messageId`, and classifies errors by their safe string codes. For Resend, follow [the transport configuration guide](development.md#swap-email-transports).

### 6. Validate and deploy

Regenerate bindings after Wrangler configuration changes, then run the checks and deploy:

```sh
npm run doctor -- --strict
npm run types:generate
npm run check
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

Checks validate source, schemas, binding declarations, and local runtime behavior. They cannot verify live credentials, sender-domain setup, or downstream delivery. The HTTP handler checks required selected-form secrets and capabilities before publication; dispatch rejects delivery attempts when required capabilities are unavailable.

Use [notification preview](development.md#preview-notifications) to inspect rendering before a controlled live submission. Preview performs no delivery and bypasses request guards. Serve the browser example's HTML and JavaScript together. Its client resets single-use Turnstile tokens after a request and reports uncertain acceptance without automatically retrying. See [Turnstile token validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

The final command deploys the Worker. Configure a custom domain or route if required, then update client endpoint URLs and allowed browser origins. Verify each configured provider with a controlled submission to a destination you own.

## Revision changes and draining

Change a destination's revision when its recipient, endpoint identity, or credential value changes, including values behind an existing secret binding. Prefer a new destination ID and secret name when changing the audience or workspace. Jobs must match the current destination ID, provider type, and revision before secrets are resolved or delivery starts.

To preserve pending deliveries to the existing target:

1. Stop incoming submissions.
2. Monitor the delivery backlog and in-flight attempts until drained.
3. Update configuration, credentials, and revision together, then resume submissions.

Alternatively, retain explicit old and new destination IDs and their credentials until old jobs drain. There is no historical destination store or automatic migration.

Removing or rotating a destination while old jobs remain produces `DESTINATION_REVISION_MISMATCH`. The dispatcher publishes a sanitized terminal failure before acknowledging the job. Rotating a credential without changing the revision violates the deployment contract; symbolic secret references cannot detect that change.

## Retry budgets and uncertain acceptance

The default consumer configuration is defined in [wrangler.jsonc](../apps/worker/wrangler.jsonc):

| Setting | Value |
| --- | --- |
| Maximum retries | 5 |
| Maximum batch size | 10 |
| Maximum batch wait | 5 seconds |
| Maximum concurrent consumer invocations | 10 |
| cf-relay retry-delay cap | 1 hour |

Attempts come from `message.attempts`. Retry delays are positive integer seconds with bounded upstream `Retry-After` hints. Cloudflare permits delays up to 24 hours; cf-relay uses the lower cap above. See [Queue limits](https://developers.cloudflare.com/queues/platform/limits/).

Messages are processed sequentially within each batch; consumer invocations can run concurrently. All destinations share the consumer, so these settings do not provide per-destination throttling.

| Operation | Deadline |
| --- | --- |
| Queue publication | 5 seconds |
| Failure-record publication | 5 seconds |
| Provider attempt | 10 seconds |
| Each request guard | 5 seconds |
| Raw-body reading | 5 seconds |

HTTP sends receive an `AbortSignal` and disable redirects. Native Cloudflare email and Queue writes cannot be canceled through these APIs and may be accepted after the deadline. Pending promises are retained where possible, but a timeout does not establish that an operation had no effect. Retrying can duplicate a notification or failure record. Resend delivery also has no durable idempotency guarantee.

## Monitor and inspect failures

Use Workers Logs or Wrangler to inspect redacted event codes and correlation IDs:

```sh
npx wrangler tail --config apps/worker/wrangler.jsonc
```

Monitor backlog and oldest-message age for both Queues. Alert on nonzero failure backlog and messages approaching retention expiry.

Events cover submission rejection, queuing, uncertain publication, delivery attempts and outcomes, revision mismatches, and failure-sink errors. Logger fields are allowlisted. Raw bodies, addresses, tokens, endpoint URLs, upstream response bodies, and error messages are omitted.

The shared `cf-relay-failures` Queue receives sanitized failure records and original jobs moved by the platform to the dead-letter Queue (DLQ). Identify envelopes by `kind` and `version`:

| Envelope | Meaning | Contains rendered content? |
| --- | --- | --- |
| `failure.record`, version 1 | Dispatcher terminal or invalid-job record | No |
| `delivery`, version 1 | Original job exhausted platform retries | Yes, may contain PII |
| Anything else | Malformed/unsupported original exhausted retries | Unknown; treat as sensitive |

Use the authenticated [Queue messages peek API](https://developers.cloudflare.com/api/typescript/resources/queues/subresources/messages/methods/peek/) to inspect messages without leasing or consuming them. The endpoint accepts `Queues Write` or `Workers Scripts Write` permissions, even for inspection. Restrict the token to the required account and operators. Use peek rather than poll or acknowledgment endpoints for read-only investigation.

```text
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/queues/{queue_id}/messages/peek
Authorization: Bearer <operator-token>
Content-Type: application/json

{"batch_size":1}
```

Do not paste envelopes into public issues or analytics. `failureEnvelopeSchema.safeParse()` recognizes supported shapes; treat unrecognized shapes as sensitive and do not print or replay them automatically.

Resolve the underlying failure before deciding whether to resubmit. Resubmission can duplicate notifications or change the destination audience. This release has no replay API or interface.

## Retention and limits

Queues store rendered messages until acknowledgment, expiry, or transfer to the DLQ. Sanitized failure records and original jobs share the failure Queue's retention settings.

Paid-plan retention defaults to four days and is configurable up to 14 days. Free-plan retention is fixed at 24 hours. See [Queue configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/) and [plan limits](https://developers.cloudflare.com/queues/platform/limits/).

Set retention deliberately and export sanitized incident metadata to external observability if a longer history is required. Messages in an unconsumed DLQ still expire.

## Platform references

- [Queue settlement APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
- [Batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Dead-letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
- [Native email API and error codes](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
