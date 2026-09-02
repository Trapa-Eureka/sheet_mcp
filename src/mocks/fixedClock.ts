// Mock implementation of Clock — returns a fixed time to make pipeline tests deterministic.
// Design: docs/TESTING.md §1 (determinism principle), §2 (mock composition table).

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
