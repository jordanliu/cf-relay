import type { Guard } from "@cf-relay/core";
export function honeypot(options: { field: string }): Guard {
  return {
    type: "honeypot",
    phase: "bot",
    fields: [options.field],
    async check(input) {
      const value = input.security[options.field];
      return value === undefined || value === ""
        ? { allowed: true }
        : { allowed: false, status: 403 };
    },
  };
}
