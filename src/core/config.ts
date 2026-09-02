// Parses the notify_config tab (SheetClient.readConfig's Record<string, string>) into a validated NotifyConfig.
// Sheet values are external input, so they are validated with zod at the boundary (CLAUDE.md convention).
// Design: docs/DESIGN.md §2 (sheet convention), task: docs/TASKS.md T1.

import { z } from "zod";

const REQUIRED_KEYS = [
  "data_tab",
  "id_column",
  "recipient_column",
  "channel",
  "subject_template",
  "body_template",
] as const;

export interface NotifyConfig {
  dataTab: string;
  idColumn: string;
  recipientColumn: string;
  channel: "email";
  subjectTemplate: string;
  bodyTemplate: string;
  filterColumn?: string;
  filterValue?: string;
}

/** Carries "what's wrong + why" and "how to fix it" so an agent can self-correct from the error message alone (CLAUDE.md convention) */
export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigParseError";
  }
}

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === "";
}

const rawConfigSchema = z.record(z.string(), z.string()).superRefine((raw, ctx) => {
  for (const key of REQUIRED_KEYS) {
    if (isBlank(raw[key])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `The '${key}' key is missing from the notify_config tab. Add a ${key}=<value> row to the notify_config tab.`,
      });
    }
  }

  const channel = raw.channel;
  if (!isBlank(channel)) {
    if (channel === "sms") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channel"],
        message:
          "channel=sms in the notify_config tab is not supported in v0.1 (SMS is planned to be added via SemaphoreSmsProvider in v0.2 — see the roadmap in docs/SPEC.md). Change channel=email in the notify_config tab.",
      });
    } else if (channel !== "email") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channel"],
        message: `The channel value '${channel}' in the notify_config tab is not supported. v0.1 supports only channel=email. Change channel=email in the notify_config tab.`,
      });
    }
  }

  const hasFilterColumn = !isBlank(raw.filter_column);
  const hasFilterValue = !isBlank(raw.filter_value);
  if (hasFilterColumn !== hasFilterValue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["filter_column"],
      message:
        "filter_column and filter_value in the notify_config tab must be set together. To use a filter, add both keys; to skip filtering, leave both empty.",
    });
  }
});

/** Call only after validation has passed — if missing here, it's an internal logic error, so raise a distinct error */
function required(value: string | undefined, key: string): string {
  if (value === undefined) {
    throw new ConfigParseError(
      `Internal error: parseNotifyConfig passed validation but the '${key}' value is empty. Please report this bug.`,
    );
  }
  return value;
}

/** For optional keys like filter_column/filter_value, normalize whitespace-only values to "missing" too (never leak the raw whitespace string through) */
function optional(value: string | undefined): string | undefined {
  return isBlank(value) ? undefined : value;
}

export function parseNotifyConfig(raw: Record<string, string>): NotifyConfig {
  const result = rawConfigSchema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("\n");
    throw new ConfigParseError(message);
  }

  const parsed = result.data;
  return {
    dataTab: required(parsed.data_tab, "data_tab"),
    idColumn: required(parsed.id_column, "id_column"),
    recipientColumn: required(parsed.recipient_column, "recipient_column"),
    channel: "email",
    subjectTemplate: required(parsed.subject_template, "subject_template"),
    bodyTemplate: required(parsed.body_template, "body_template"),
    filterColumn: optional(parsed.filter_column),
    filterValue: optional(parsed.filter_value),
  };
}
