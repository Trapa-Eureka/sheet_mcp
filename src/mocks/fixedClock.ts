// Clock 목 구현 — 고정 시각을 반환해 파이프라인 테스트를 결정론적으로 만든다.
// 설계: docs/TESTING.md §1(결정론 원칙), §2(mock 구성표).

import type { Clock } from "../core/types.js";

const DEFAULT_FIXED_TIME = "2026-09-01T00:00:00.000Z";

export class FixedClock implements Clock {
  private readonly fixed: Date;

  constructor(iso: string = DEFAULT_FIXED_TIME) {
    this.fixed = new Date(iso);
  }

  now(): Date {
    return this.fixed;
  }
}
