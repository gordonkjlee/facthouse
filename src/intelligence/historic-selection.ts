/**
 * Line count and truncated-character size of a historic extract choice.
 * Same recency clock as extract (`lineTimeMs`).
 */

import type { Db } from "../db/connection.js";
import { listUnexaminedEventRows } from "../db/extract-watermarks.js";
import { DEFAULT_CONFIG } from "../types/config.js";
import { lineTimeMs } from "./line-time.js";

export interface HistoricSelection {
  chosenCount: number;
  truncatedChars: number;
}

export type HistoricSelectionChoice =
  | { kind: "all" }
  | { kind: "limit"; n: number }
  | { kind: "days"; days: number };

function parseMetadata(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function measureHistoricSelection(
  db: Db,
  choice: HistoricSelectionChoice,
  maxContentLength: number = DEFAULT_CONFIG.extraction.max_content_length,
): Promise<HistoricSelection> {
  const rows = await listUnexaminedEventRows(db);
  const cap = Math.max(1, maxContentLength);
  const sinceMs =
    choice.kind === "days"
      ? Date.now() - choice.days * 24 * 60 * 60 * 1000
      : undefined;
  const limit = choice.kind === "limit" ? choice.n : Number.POSITIVE_INFINITY;
  let chosenCount = 0;
  let truncatedChars = 0;
  for (const row of rows) {
    if (sinceMs !== undefined) {
      const t = lineTimeMs({
        occurred_at: row.occurred_at,
        created_at: row.created_at,
        metadata: parseMetadata(row.metadata),
      });
      if (t < sinceMs) continue;
    }
    if (chosenCount >= limit) break;
    chosenCount += 1;
    truncatedChars += Math.min(row.content?.length ?? 0, cap);
  }
  return { chosenCount, truncatedChars };
}
