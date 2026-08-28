/**
 * Extra evidence on a fact that was already said: assent, tool observation,
 * restatement by a different speaker. Not a second extract and not a
 * confidence bump. `corroborating` stays "mentioned again" by the same speaker.
 */

import type { Db } from "../db/connection.js";
import { linkFactSource } from "../db/session-facts.js";
import type { SessionEvent } from "../types/data.js";
import type { ExtractionType } from "../types/data.js";

/**
 * Whole-line yes-family. Keep short: "yesterday" must not match.
 * One definition — tests and detectors import this list.
 */
export const ASSENT_LEXICON = [
  "yes",
  "yeah",
  "yep",
  "ok",
  "okay",
  "correct",
  "that's right",
  "that is right",
] as const;

export function isAssentLine(content: string | null | undefined): boolean {
  if (!content) return false;
  let t = content.trim().toLowerCase();
  if (t.endsWith(".") || t.endsWith("!")) t = t.slice(0, -1).trim();
  return (ASSENT_LEXICON as readonly string[]).includes(t);
}

function containsFact(event: SessionEvent, factContent: string): boolean {
  return Boolean(event.content && event.content.includes(factContent));
}

function differentSpeaker(a: SessionEvent, b: SessionEvent): boolean {
  return a.speaker !== b.speaker || a.role !== b.role;
}

async function linkOnce(
  db: Db,
  sessionFactId: string,
  eventId: string,
  extractionType: ExtractionType,
  relevance: number,
): Promise<void> {
  await linkFactSource(db, {
    session_fact_id: sessionFactId,
    event_id: eventId,
    relevance,
    extraction_type: extractionType,
  });
}

/**
 * Attach at most one assent, one observation, and one restatement.
 * Call after primary / mentioned-again / contextual linking.
 */
export async function attachBackingSources(
  db: Db,
  sessionFactId: string,
  factContent: string,
  groupEvents: SessionEvent[],
): Promise<void> {
  const primary = groupEvents.find((e) => containsFact(e, factContent));
  if (!primary) return;

  let observation = false;

  for (const event of groupEvents) {
    if (event.id === primary.id) continue;
    if (
      primary.role !== "tool" &&
      event.role === "tool" &&
      containsFact(event, factContent) &&
      !observation
    ) {
      await linkOnce(db, sessionFactId, event.id, "observation", 0.6);
      observation = true;
    }
  }

  for (const event of groupEvents) {
    if (event.id === primary.id) continue;
    if (!containsFact(event, factContent)) continue;
    if (event.sequence <= primary.sequence) continue;
    if (!differentSpeaker(event, primary)) continue;
    if (observation && event.role === "tool") continue;
    await linkOnce(db, sessionFactId, event.id, "restatement", 0.55);
    break;
  }

  for (const event of groupEvents) {
    if (event.sequence <= primary.sequence) continue;
    if (event.role !== "user") continue;
    if (!isAssentLine(event.content)) continue;
    await linkOnce(db, sessionFactId, event.id, "assent", 0.7);
    break;
  }
}
