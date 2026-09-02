// Clock의 실제 구현 — 시스템 현재 시각을 반환한다.
// 설계: docs/DESIGN.md §3(Clock). 테스트는 결정론이 필요하므로 src/mocks/fixedClock.ts를 쓴다
// (docs/TESTING.md §1) — 이 어댑터 자체는 단순 위임이라 별도 단위 테스트를 두지 않는다.

import type { Clock } from "../core/types.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
