// Real implementation of Clock — returns the current system time.
// Design: docs/DESIGN.md §3 (Clock). Tests need determinism, so they use src/mocks/fixedClock.ts
// (docs/TESTING.md §1) — this adapter itself is a simple delegation, so it has no separate unit test.

import type { Clock } from "../core/types.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
