/**
 * Kept out of format.tsx (JSX) so it can be unit-tested directly through
 * Vitest without a JSX transform in the loop -- see reasons.test.ts.
 */

/** Renders a reason's `detail` (arbitrary key/value snapshot from the
 * engine, e.g. `{ amount, threshold }`) as one readable line, for the
 * approval UI and the receipt's reasons list. */
export function formatDetail(detail: Record<string, unknown> | undefined): string | null {
  if (!detail || Object.keys(detail).length === 0) return null;
  return Object.entries(detail)
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(", ");
}
