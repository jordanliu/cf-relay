import { dirname, join, resolve } from "node:path";

export function projectPaths(root: string, configPath?: string) {
  const configuration = resolve(
    root,
    configPath ?? "apps/worker/relay.config.ts",
  );
  const directory = dirname(configuration);
  const deploymentDirectory =
    directory === resolve(root, "apps/worker") ? root : directory;
  return {
    configPath: configuration,
    wranglerPath: join(deploymentDirectory, "wrangler.jsonc"),
    bindingsPath: join(directory, "worker-configuration.d.ts"),
    fixturePath: join(directory, "fixture.json"),
    secretsPath: join(deploymentDirectory, ".dev.vars"),
    legacySecretsPath:
      deploymentDirectory === directory
        ? undefined
        : join(directory, ".dev.vars"),
  };
}
