/**
 * One definition of what D→I extract-context fields *are*.
 *
 * Sampling and CLI previously drifted: sampling shrank recent_events to
 * "pronoun resolution" while CLI kept topical flow. The jobs below are the
 * contract; each provider may still describe what a durable fact is in its
 * own voice.
 */

import type { Referent } from "../types/data.js";

/** Live deictics kept for the current activity. Last-known only. */
export const REFERENT_CAP = 8;

/** First eight of the model's list. No merge with the previous board. */
export function capReferents(referents: Referent[] | undefined): Referent[] {
  if (!referents) return [];
  return referents.slice(0, REFERENT_CAP);
}

/** Happy-path raw prefix passed as recent_events. Evidence, not the board. */
export const EXTRACT_EVIDENCE_SLICE = 8;

/** Forgetfulness reread: short window of this conversation's session_events. */
export const EXTRACT_REREAD_WINDOW = 20;

/**
 * Prompt-reported extract confidence below this triggers one reread.
 * Absent confidence is treated as confident (the heuristic must not reread).
 */
export const EXTRACT_REREAD_CONFIDENCE = 0.5;

/**
 * Graduated facts passed into D→I. Not the whole store — a small related
 * set from hybrid search. Cue, not veto.
 */
export const EXTRACT_RELATED_K_CAP = 8;

export const EXTRACT_CONTEXT_CONTRACT = `
Extract-context fields (do not paraphrase these jobs):

- candidate_events: the only lines to extract facts from. Each has role, content, and said_at (ISO instant when the line was uttered, or null if unknown).
- session_now: the current ACTIVITY (1–3 sentences). What we are doing. Evolves in place. Not the referent board.
- referents: last-known board for live deictics in this now, as {phrase, binding} objects, at most ${REFERENT_CAP}. Examples of phrases: "the file", "we", "that approach", "the programme". Episode-local nicknames, not long-term facts. Return the whole live set each time; drop what is no longer live.
- topic_segments: closed nows, oldest first. Each has a gist, the referents as they were then, and an event-sequence range. A later turn can return to one. Do not rewrite them away. A binding change is NOT a new segment.
- recent_events: a short raw prefix of this conversation. Evidence that session_now has not drifted. Do NOT extract from it. Do NOT treat it as the disambiguation table.
- session_summary: rolling gist of the episode. May mention closed topics; the segment list is the topic log.
- long_term_memory: a small set of related graduated facts (not the whole store). Use to resolve a name this episode never introduced, and to skip duplicating what is already known. If a new candidate line CONTRADICTS long_term_memory, extract the new fact anyway — updating the graph happens later. Do not silence the line.
- reminder_events: present only on a retry. A short look at this conversation's raw log because the previous pass could not tell. Reminder only. Do NOT extract facts from reminder_events unless the same content is also in candidate_events.

session_now / topic_shifted / referents:
1. Set topic_shifted true only if a later speaker would say "back to the previous thing" as a topic return. Refinements and "the file is now sampling.ts" are not shifts.
2. Evolve session_now in place when the activity is the same job with a moved centre of gravity.
3. Update referents whenever a live deictic changed, appeared, or died. At most ${REFERENT_CAP}; drop what is no longer live. Do not list long-term entities this episode has not used as deictics.

If the candidate lines are mostly unresolved deictics, or you cannot tell what was said, set confidence below ${EXTRACT_REREAD_CONFIDENCE} so the caller can show you a short reminder. Still extract only from candidate_events.

Dates (do not invent an ISO):
- extract_today is this extract's UTC calendar day. It is not when a line was said.
- Resolve a relative phrase ("yesterday", "last year") against that line's said_at into an absolute date in the sentence, and set valid_from to that ISO day. A past event that remains true as history leaves valid_until null.
- If said_at is null, or the speaker was approximate ("about five years ago", "when I was younger"), keep the hedge in the sentence and set valid_from and valid_until to null. Never guess a calendar day. Do not use extract_today as a stand-in for a missing said_at.
`.trim();

/** Payload shape for extract event lists — one definition for CLI and sampling. */
export function extractEventPayload(event: {
  role: string;
  content: string | null;
  occurred_at?: string | null;
}): { role: string; content: string | null; said_at: string | null } {
  return {
    role: event.role,
    content: event.content,
    // Ingest time is not a stand-in: a late pull would resolve "yesterday"
    // against the wrong day. Null said_at means do not invent a date.
    said_at: event.occurred_at ?? null,
  };
}

/** UTC calendar day of this extract, YYYY-MM-DD. Not utterance time. */
export function extractTodayUtcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Accept an extract-emitted timestamp only when it is a real ISO day or
 * instant. "yesterday" and "about 2019" become null rather than a confident
 * wrong Date parse.
 */
export function parseExtractedIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
