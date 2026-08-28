import { describe, it, expect } from "vitest";
import { interlocutorRankMultiplier } from "../../src/search/interlocutor-rank.js";

describe("interlocutorRankMultiplier", () => {
  it("is 1 when config is missing or the key is unset", () => {
    const fact = { speaker_role: "user" as const, speaker: "Alex" };
    expect(interlocutorRankMultiplier(fact, undefined)).toBe(1);
    expect(interlocutorRankMultiplier(fact, {})).toBe(1);
    expect(interlocutorRankMultiplier(fact, { role_weights: { assistant: 2 } })).toBe(1);
    expect(interlocutorRankMultiplier(fact, { speaker_weights: { Robin: 2 } })).toBe(1);
  });

  it("multiplies role and speaker weights when both are set", () => {
    const fact = { speaker_role: "user" as const, speaker: "Alex" };
    expect(
      interlocutorRankMultiplier(fact, {
        role_weights: { user: 2 },
        speaker_weights: { Alex: 3 },
      }),
    ).toBe(6);
  });

  it("does not invent 0.5 for a missing map", () => {
    expect(
      interlocutorRankMultiplier(
        { speaker_role: null, speaker: null },
        { role_weights: { user: 2 } },
      ),
    ).toBe(1);
  });
});
