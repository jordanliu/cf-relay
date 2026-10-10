import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(join(path, entry.name))
          : [join(path, entry.name)],
      ),
    )
  ).flat();
}
const rules = [
  [
    "packages/core/src",
    /(?:cloudflare:|@cloudflare|hono|@cf-relay\/(?:runtime|provider|email|polic))|\b(?:Queue|SendEmail|MessageBatch|ExecutionContext|RateLimit)\s*[<({]/,
  ],
  [
    "packages/runtime-cloudflare/src",
    /from\s*["']@cf-relay\/(?:provider-|email-)/,
  ],
  [
    "packages/providers",
    /from\s*["'](?:@cf-relay\/runtime|cloudflare:|@cloudflare)/,
  ],
];
for (const [path, pattern] of rules)
  for (const file of await files(path))
    if (file.endsWith(".ts") && pattern.test(await readFile(file, "utf8")))
      throw new Error(`Architecture boundary violation: ${file}`);
console.log("Architecture import boundaries passed");
