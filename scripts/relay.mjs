import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, ".scratch");
await mkdir(directory, { recursive: true });
const output = join(directory, `relay-cli-${randomUUID()}.mjs`);
try {
  await build({
    entryPoints: [join(root, "scripts/tooling/cli.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["esbuild", "typescript"],
    logLevel: "silent",
  });
  const { main } = await import(pathToFileURL(output).href);
  process.exitCode = await main(process.argv.slice(2), root);
} catch {
  console.error("Unable to start relay tooling. Run npm ci and try again.");
  process.exitCode = 1;
} finally {
  await rm(output, { force: true });
}
