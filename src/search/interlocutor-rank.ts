/**
 * Optional search ranking priors by speaker role or display name.
 * Unset config or unset key → 1 (no change). Never invent 0.5.
 */

import type { InterlocutorConfig } from "../types/config.js";

export function interlocutorRankMultiplier(
  fact: { speaker_role: string | null; speaker: string | null },
  config: InterlocutorConfig | undefined | null,
): number {
  if (!config) return 1;
  let m = 1;
  if (config.role_weights && fact.speaker_role) {
    const w = config.role_weights[fact.speaker_role as keyof typeof config.role_weights];
    if (typeof w === "number" && Number.isFinite(w)) m *= w;
  }
  if (config.speaker_weights && fact.speaker) {
    const w = config.speaker_weights[fact.speaker];
    if (typeof w === "number" && Number.isFinite(w)) m *= w;
  }
  return m;
}
