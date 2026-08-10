/**
 * Ghostly Max gateway codes → translation keys.
 *
 * The same closed set appears in three places by design: `src/ai.ts` in the
 * Worker emits them, `max_gateway.rs` parses them, and this maps them to copy.
 * Keeping the mapping in one module means the toast, the AI Refinement pane,
 * and the Account pane cannot drift into describing the same state three ways.
 *
 * Returns `null` for anything unrecognised so callers can fall back to the
 * generic error path rather than showing a wrong-but-confident message.
 */
export function maxErrorKey(code: string): string | null {
  switch (code) {
    case "not_max":
      return "max.errors.notMax";
    case "expired":
      return "max.errors.expired";
    case "unpaid":
      return "max.errors.unpaid";
    case "revoked":
      return "max.errors.revoked";
    case "fair_use_exceeded":
      return "max.errors.fairUseExceeded";
    case "upstream_error":
      return "max.errors.upstreamError";
    case "missing_key":
    case "invalid_key":
      return "max.errors.invalidKey";
    default:
      return null;
  }
}

/**
 * Same mapping, but for `GET /ai/status`'s `reason` field, where an
 * unrecognised value still needs *something* on screen.
 */
export function maxReasonKey(reason: string): string {
  return maxErrorKey(reason) ?? "max.errors.generic";
}
