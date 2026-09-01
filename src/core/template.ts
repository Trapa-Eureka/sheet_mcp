// 템플릿 렌더링 — 순수 함수, 외부 IO 없음.
// 설계: docs/DESIGN.md §3(RenderResult), 태스크: docs/TASKS.md T4.

import type { RenderResult } from "./types.js";

// {{key}} 형태만 인식한다. 중괄호 안 공백은 허용(`{{ name }}`), 키는 시트 헤더명과 같은 문자만.
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * {{key}} 플레이스홀더를 values로 치환한다.
 * - 값이 결측(키가 record에 없음, 즉 undefined)이면 원본 플레이스홀더를 그대로 남기고
 *   missing[]에 그 키를 담는다 — throw하지 않는다. 파이프라인이 행 단위로 실패 처리할 수 있도록
 *   (DESIGN §3, §4-3단계).
 * - 값이 빈 문자열("")인 것은 "결측"이 아니다 — 키는 존재하고 값만 비어 있는 정상 케이스로,
 *   빈 문자열로 치환되고 missing에 들어가지 않는다.
 * - 같은 키가 템플릿에 여러 번 나오면 missing에는 한 번만 담긴다(중복 제거).
 * - String.prototype.replace에 문자열을 넘기면 `$&`/`$1` 같은 패턴이 특수 해석되므로,
 *   치환값이 그대로 삽입되도록 반드시 함수 콜백으로 치환한다(이스케이프 불필요).
 */
export function renderTemplate(template: string, values: Record<string, string>): RenderResult {
  const missing: string[] = [];
  const seenMissing = new Set<string>();

  const text = template.replace(PLACEHOLDER_PATTERN, (placeholder: string, key: string) => {
    const value = values[key];
    if (value === undefined) {
      if (!seenMissing.has(key)) {
        seenMissing.add(key);
        missing.push(key);
      }
      return placeholder;
    }
    return value;
  });

  return { text, missing };
}
