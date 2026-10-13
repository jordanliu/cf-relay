# Security policy

## Reporting a vulnerability

Do not include credentials, form content, email addresses, or Queue payloads in public reports. For a sensitive issue, use GitHub private vulnerability reporting when enabled, or contact the repository owner privately before sharing details publicly.

## Deployment responsibilities

The source API is pre-1.0. Operators are responsible for their Cloudflare account, secrets, destination revisions, Queue retention, monitoring, and access controls.

Forms require API-key protection or rate limiting with Turnstile unless `unsafeAllowUnprotected: true` explicitly disables this requirement. Honeypot checks supplement these protections. CORS restricts browser origins and does not authenticate requests. Store API keys only on trusted servers.

Changes to destination identity or credentials require a new revision. Revision checks prevent pending jobs from being delivered to changed targets only when operators also update the revision for secret-value changes. See [revision changes and draining](docs/operations.md#revision-changes-and-draining).

## Extension trust

Community providers run as trusted code in the same Worker. They have access to Worker globals and are not sandboxed. Review third-party modules before deployment.

Local doctor and preview commands import the relay configuration. Preview also executes schemas and message transforms. These run as trusted code on the developer's machine. Review configuration before running the tools; they do not isolate arbitrary side effects.

## Stored data and delivery

Delivery jobs contain rendered notification content, which may include personal data. The delivery Queue and dead-letter Queue can retain this content. Sanitized terminal failure records omit rendered content, but share a Queue with original jobs that exhaust retries.

Fixtures and notification previews can contain personal data. Keep local outputs in the Git-ignored `.scratch` directory and review them before sharing.

Retries can duplicate notifications. Apply appropriate access controls and retention settings to both Queues; see [failure inspection](docs/operations.md#monitor-and-inspect-failures) and [retention and limits](docs/operations.md#retention-and-limits).
