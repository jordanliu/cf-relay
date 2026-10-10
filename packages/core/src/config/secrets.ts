import type { SecretReader } from "../contracts/ports";
import type { ResolveSecrets } from "../domain/models";
import { secretRefSchema } from "../domain/validation";

export function secretNames(value: unknown): string[] {
  const names = new Set<string>();
  function visit(input: unknown): void {
    const ref = secretRefSchema.safeParse(input);
    if (ref.success) {
      names.add(ref.data.name);
      return;
    }
    if (input && typeof input === "object")
      for (const child of Object.values(input)) visit(child);
  }
  visit(value);
  return [...names];
}
export async function resolveSecrets<T>(
  value: T,
  reader: SecretReader,
): Promise<ResolveSecrets<T>> {
  async function resolve(input: unknown): Promise<unknown> {
    const ref = secretRefSchema.safeParse(input);
    if (ref.success) {
      const result = await reader.read(ref.data.name);
      if (typeof result !== "string" || !result)
        throw new Error("Required secret unavailable");
      return result;
    }
    if (Array.isArray(input)) return Promise.all(input.map(resolve));
    if (input && typeof input === "object") {
      const entries = await Promise.all(
        Object.entries(input).map(
          async ([key, child]) => [key, await resolve(child)] as const,
        ),
      );
      return Object.fromEntries(entries);
    }
    return input;
  }
  return (await resolve(value)) as ResolveSecrets<T>;
}
