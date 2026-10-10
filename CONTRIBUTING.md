# Contributing

Use Node 22.12+ and npm. Run `npm ci`, then `npm run check` before proposing changes. `npm run format` formats source; lint includes promise handling and architecture import checks. Regenerate Worker bindings with `npm run types:generate` after Wrangler config changes.

Core must remain free of Cloudflare, Hono, providers, and email vendors. Providers must not import runtime adapters or composition code, and runtime adapters must not import providers. Keep type erasure at registry boundaries; preserve literal keys and schema inference in public builders. Use strict schemas, scoped secrets, safe error codes, and bounded network bodies. Never log raw errors, submissions, tokens, addresses, or endpoint credentials.

Tests must use fake credentials and mocked HTTP/email capabilities. No live sends, deployments, or infrastructure writes belong in tests or CI. Platform fixtures may use temporary local storage only for assertions; production has no application database. Add tests for security and settlement behavior, not assertions mirroring an implementation detail.

Provider changes must cover mention/markup safety, upstream acceptance, transient versus terminal classification, limits, and cancellation. Queue changes must preserve independent settlement, sanitized failure publication before ack, ambiguous publication semantics, and destination revision checks before secret resolution. Explain any wire-format or operational migration in the PR.
