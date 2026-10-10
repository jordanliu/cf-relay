export class RelayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}
export const unavailable = () =>
  new RelayError(
    503,
    "SERVICE_UNAVAILABLE",
    "Submission service is unavailable.",
  );
export const invalidMessage = () =>
  new RelayError(
    422,
    "INVALID_MESSAGE",
    "Generated message exceeds supported limits or is invalid.",
  );
