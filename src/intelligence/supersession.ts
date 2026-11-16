/**
 * Shared supersession contract for every provider.
 *
 * The project a fact was recorded in travels with the fact as evidence.
 * It is not a wall: two statements may both be true in their own setting.
 */

import type { ContextVerdict, SourceQuality, SupersessionBasis } from "../types/data.js";
import { SUPERSESSION_BASES } from "../types/data.js";
import type { SupersessionCandidate, SupersessionContext } from "./types.js";

/**
 * Added to every supersession prompt. The counter-instruction is the
 * named artefact / a state that cannot hold twice: that is an update.
 * A preference, a convention, or a situational trait can coexist.
 */
export const SUPERSESSION_CONTEXT_INSTRUCTION =
  'Each fact carries the project it was recorded in. Two statements may both be true in their own setting (a preference, a convention, a situational trait) whether or not the projects differ. Return basis: "update" when the new fact states the old one has stopped being true of the same specific thing — a named artefact, a state that cannot hold twice. Return basis: "coexists" when both can hold in their own setting. Return basis: "uncertain" when you cannot tell an update from a contextual truth.';

export function supersessionBasis(value: unknown): SupersessionBasis | undefined {
  if (typeof value !== "string") return undefined;
  return (SUPERSESSION_BASES as readonly string[]).includes(value)
    ? (value as SupersessionBasis)
    : undefined;
}

/** Remember who actually answered, including a decision not to propose. */
export function noteSupersessionAnswer(
  context: SupersessionContext | undefined,
  by: SourceQuality,
): void {
  if (context) context.answeredBy = by;
}

export function buildSupersessionCandidate(
  existingFactId: string,
  reason: unknown,
  basis: unknown,
  sourceQuality: SourceQuality,
): SupersessionCandidate {
  return {
    existingFactId,
    reason:
      typeof reason === "string" && reason.trim() !== ""
        ? reason
        : "no reason returned",
    basis: supersessionBasis(basis),
    source_quality: sourceQuality,
  };
}

export interface SupersessionPayloadFact {
  id: string;
  content: string;
  domain: string;
  project: string | null;
}

export interface SupersessionPayloadExisting {
  id: string;
  content: string;
  project: string | null;
  context: ContextVerdict;
}

/**
 * The body every provider sends. `project` is the short key. `context` on
 * an existing fact is the verdict for that pair, not the whole call.
 */
export function supersessionPayload(
  newFact: { id: string; content: string; domain: string },
  existing: Array<{ id: string; content: string }>,
  context: SupersessionContext | undefined,
): { incoming: SupersessionPayloadFact; existing: SupersessionPayloadExisting[] } {
  return {
    incoming: {
      id: newFact.id,
      content: newFact.content,
      domain: newFact.domain,
      project: context?.project ?? null,
    },
    existing: existing.map((fact) => ({
      id: fact.id,
      content: fact.content,
      project: context?.projects.get(fact.id) ?? null,
      context: context?.verdicts.get(fact.id) ?? "not_comparable",
    })),
  };
}
