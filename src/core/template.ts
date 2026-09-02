// Template rendering — a pure function, no external IO.
// Design: docs/DESIGN.md §3 (RenderResult), task: docs/TASKS.md T4.

import type { RenderResult } from "./types.js";

// Only recognizes the {{key}} form. Any character other than the two braces is allowed in the
// key — to match DESIGN §2's contract that "the header name is the template variable name",
// keys must be recognized even when they contain Korean/Tagalog characters, spaces, or hyphens,
// which are common in real Google Sheets headers (narrowing this to ASCII alphanumerics plus
// underscore would mean those keys are not even detected as missing, and unsubstituted text
// could be sent as-is — docs/ADVERSARIAL_REVIEW_002.md AR-006).
// Only leading/trailing whitespace is trimmed (`{{ name }}` is allowed).
const PLACEHOLDER_PATTERN = /\{\{([^{}]+)\}\}/g;

/**
 * Substitutes {{key}} placeholders with values.
 * - If a value is missing (the key is not present in the record, i.e. undefined), the original
 *   placeholder is left as-is and the key is added to missing[] — it does not throw, so the
 *   pipeline can fail the row individually (DESIGN §3, §4 step 3).
 * - An empty string ("") value is NOT "missing" — the key exists and only the value is empty,
 *   a normal case; it is substituted with the empty string and not added to missing.
 * - If the same key appears multiple times in the template, it is added to missing only once
 *   (deduplicated).
 * - Passing a string to String.prototype.replace specially interprets patterns like `$&`/`$1`,
 *   so a function callback is used for substitution to ensure the replacement value is inserted
 *   verbatim (no escaping needed).
 */
export function renderTemplate(template: string, values: Record<string, string>): RenderResult {
  const missing: string[] = [];
  const seenMissing = new Set<string>();

  const text = template.replace(PLACEHOLDER_PATTERN, (placeholder: string, rawKey: string) => {
    const key = rawKey.trim();
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
