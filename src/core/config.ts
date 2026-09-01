// notify_config 탭(SheetClient.readConfig의 Record<string, string>)을 검증된 NotifyConfig로 파싱한다.
// 시트 값은 외부 입력이므로 경계에서 zod로 검증한다 (CLAUDE.md 컨벤션).
// 설계: docs/DESIGN.md §2(시트 규약), 태스크: docs/TASKS.md T1.

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

/** 에이전트가 에러 메시지만 보고 자가 수정할 수 있도록 "무엇이 왜 + 어떻게 고치나"를 담는다 (CLAUDE.md 컨벤션) */
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
        message: `notify_config 탭에 '${key}' 키가 없습니다. notify_config 탭에 ${key}=<값> 행을 추가하세요.`,
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
          "notify_config 탭의 channel=sms는 v0.1에서 지원하지 않습니다 (SMS는 v0.2에서 SemaphoreSmsProvider로 추가 예정, docs/SPEC.md 로드맵 참고). notify_config 탭에서 channel=email로 바꾸세요.",
      });
    } else if (channel !== "email") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channel"],
        message: `notify_config 탭의 channel 값 '${channel}'은 지원하지 않습니다. v0.1은 channel=email만 허용합니다. notify_config 탭에서 channel=email로 바꾸세요.`,
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
        "notify_config 탭의 filter_column과 filter_value는 함께 설정해야 합니다. 필터를 쓰려면 두 키를 모두 추가하고, 안 쓰려면 둘 다 비우세요.",
    });
  }
});

/** 검증 통과가 보장된 뒤에만 호출 — 결측이면 내부 로직 오류이므로 별도 에러로 구분한다 */
function required(value: string | undefined, key: string): string {
  if (value === undefined) {
    throw new ConfigParseError(
      `내부 오류: parseNotifyConfig 검증을 통과했지만 '${key}' 값이 비어 있습니다. 버그를 리포트하세요.`,
    );
  }
  return value;
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
    filterColumn: parsed.filter_column,
    filterValue: parsed.filter_value,
  };
}
