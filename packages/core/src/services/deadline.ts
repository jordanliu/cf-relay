// All callers retain/handle the underlying promise. A timeout does not imply zero side effects.
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DeadlineError());
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}
export class DeadlineError extends Error {
  constructor() {
    super("Operation deadline exceeded");
    this.name = "DeadlineError";
  }
}
