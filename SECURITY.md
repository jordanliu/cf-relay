# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting when enabled, or contact the owner privately. Exclude credentials, addresses, form content, and Queue payloads from public reports.

## Deployment responsibilities

Operators manage account access, secrets, destination revisions, monitoring, and retention. Store API keys on trusted servers and never commit or log credentials.

Forms require API-key protection or rate limiting with Turnstile unless `unsafeAllowUnprotected: true` is explicit. Honeypot is supplementary; CORS does not authenticate requests.

Update destination revisions for audience, endpoint, or credential changes. Follow the [draining procedure](docs/operations.md#revision-changes-and-draining).

## Extension trust

Providers run as trusted Worker code. Doctor and preview import configuration on the developer's machine; preview also executes schemas and transforms. These are not sandboxes. Review third-party code before use.

## Stored data and delivery

Queues, fixtures, and previews can contain personal data. Sanitized failure records share the failure Queue with original exhausted jobs. Restrict access and retention; keep temporary previews in Git-ignored `.scratch`.

Retries can duplicate notifications. See [failure inspection](docs/operations.md#monitor-and-inspect-failures) and [retention](docs/operations.md#retention-and-limits).
