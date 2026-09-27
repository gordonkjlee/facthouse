/**
 * Instant used for historic recency windows. One definition for the 7d/30d
 * count and the extract filter.
 *
 * Speech time first. Cursor has no said-at: copy stamps `metadata.source_mtime`
 * (transcript file last written) without writing `occurred_at`. Copy time is
 * last — a first Cursor copy without that stamp still looks like “now”.
 */

export const SOURCE_MTIME_META = "source_mtime";

function parseInstant(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function sourceMtimeOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[SOURCE_MTIME_META];
  return typeof value === "string" ? value : null;
}

export function lineTimeMs(event: {
  occurred_at?: string | null;
  created_at?: string | null;
  metadata?: unknown;
}): number {
  const said = parseInstant(event.occurred_at);
  if (said != null) return said;
  const fileTouch = parseInstant(sourceMtimeOf(event.metadata));
  if (fileTouch != null) return fileTouch;
  const copied = parseInstant(event.created_at);
  if (copied != null) return copied;
  return Number.POSITIVE_INFINITY;
}
