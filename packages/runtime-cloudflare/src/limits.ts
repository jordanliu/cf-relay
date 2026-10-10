import { binding } from "./capabilities";
export async function cloudflareRateLimit(
  env: object,
  name: string,
  key: string,
): Promise<boolean> {
  const candidate = binding(env, name);
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("limit" in candidate) ||
    typeof candidate.limit !== "function"
  )
    throw new Error("Rate-limit binding unavailable");
  const result: unknown = await candidate.limit({ key });
  if (
    !result ||
    typeof result !== "object" ||
    !("success" in result) ||
    typeof result.success !== "boolean"
  )
    throw new Error("Rate-limit binding invalid");
  return result.success;
}
