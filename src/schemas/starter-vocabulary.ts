/**
 * A starting vocabulary, written into the user's `config.json` at init.
 *
 * **This is not a core, and the engine does not know these names.** It is data:
 * seeded once into a file the user owns, then read back like any other config.
 * Delete it, rename it, replace it wholesale — nothing in `src/` refers to
 * `medical` or `preferences`, and nothing breaks if they are gone. The only
 * domain the engine knows is `general`, the fallback.
 *
 * It is personal-flavoured because personal is the use case OpenMemory is
 * best at, and an empty vocabulary gives a classifier nothing to be consistent
 * with on day one. It is *not* a claim about what domains are. A corporate store
 * replaces this with clients, incidents, contracts, suppliers; a research store
 * with papers, experiments, datasets. Both are equally correct, and the engine
 * cannot tell the difference — which is the point.
 *
 * Each domain carries its own:
 *   - `description` — shown to a classifier so it routes on meaning, not a guess
 *     at what a bare name implies.
 *   - `patterns` — for the fallback classifier, when no LLM is available. These
 *     are the most obviously non-universal part: "allergic" and "partner" are
 *     noise in a corporate store, and "SLA" and "incident" would be noise here.
 *   - `importance` — because a missed allergy is the costliest error in a
 *     personal store, and a missed SLA breach in a corporate one.
 *
 * Patterns match how facts are actually written. `capture_fact` is called by an
 * assistant recording a fact *about* its user, so content arrives in the third
 * person ("The user prefers dark roast"), not the first ("I prefer dark roast").
 * Verbs therefore need their -s form: `prefers?`, not `prefer` — `\bprefer\b`
 * does not match "prefers".
 */

import type { DomainDef } from "../types/config.js";

export const STARTER_VOCABULARY: DomainDef[] = [
  {
    // First: health information takes priority, and a false positive here is
    // safer than a miss. Order is precedence — the fallback stops at the first
    // match.
    name: "medical",
    description: "health conditions, allergies, medication, treatment",
    subdomains: [],
    patterns: [
      "\\b(allerg|medicat|doctor|diagnosis|condition|symptom|treatment|prescription|health|hospital|clinic|vaccine|blood|surgery|therapy|illness|disease)",
    ],
    importance: 0.9,
  },
  {
    name: "profile",
    description: "core identity — name, demographics, location, occupation",
    subdomains: [],
    patterns: [
      // First person, as a user states it.
      "\\b(my name is|i am|i'm|born|nationality|age|birthday|occupation|job title)\\b",
      "\\bi (live|lives) in\\b",
      // Third person, as an assistant records it about its user.
      "\\bthe user('s)? (is|was|has been)? ?(called|named)\\b",
      "\\bthe user's (name|age|birthday|nationality|occupation|job title)\\b",
      "\\b(the user|they) (lives?|moved|grew up|was born)\\b",
    ],
    importance: 0.85,
  },
  {
    // Ahead of preferences: a relationship noun says who a fact is about, which
    // outranks a preference verb saying what it mentions. "My partner Robin
    // loves sushi" is a fact about Robin.
    name: "people",
    description: "relationships and the people in the user's life",
    subdomains: [],
    patterns: [
      "\\b(partner|wife|husband|friend|colleague|boss|sister|brother|mother|father|son|daughter|neighbour|neighbor)\\b",
    ],
    importance: 0.6,
  },
  {
    name: "work",
    description: "employment, projects, teams, deadlines",
    subdomains: [],
    patterns: [
      "\\b(project|sprint|deploy|meeting|team|company|client|deadline|standup|release|merge|repository|codebase)\\b",
    ],
    importance: 0.6,
  },
  {
    name: "preferences",
    description: "likes, dislikes, favourites, habits",
    subdomains: [],
    patterns: [
      "\\b(prefers?|favourites?|favorites?|likes?|loves?|hates?|dislikes?|enjoys?|can't stand|would rather|rather)\\b",
    ],
    importance: 0.4,
  },
];
