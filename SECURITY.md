# Security policy

Do not include credentials, form content, email addresses, or Queue payloads in public reports. For a sensitive issue, use GitHub private vulnerability reporting when enabled, or contact the repository owner privately before sharing details publicly.

The current source release is pre-1.0. Deployers own their Cloudflare account, secrets, configured destination revisions, Queue retention, monitoring, and access controls. Public forms require rate limit plus Turnstile unless explicitly opted out; CORS and honeypot alone do not authenticate a caller. API keys belong on trusted servers.

Community provider code is trusted code running in the same Worker and has no sandbox isolation. The main and dead-letter Queues can retain rendered personal content. Fail-closed revisions prevent redirecting old jobs to changed targets only when operators also bump revisions for secret-value changes. At-least-once retries can duplicate notifications.
