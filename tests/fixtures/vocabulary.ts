/**
 * Vocabularies for tests. **Fixtures, not shipped code.**
 *
 * The engine ships no categories and no rules — it knows one domain, `general`,
 * and reads everything else from config. So a test that expects routing or
 * calibration has to declare a vocabulary, exactly as a user does. That is the
 * point: if these lived in `src/`, the engine would have an opinion again.
 *
 * Two are provided deliberately. Most tests can use either; using the corporate
 * one where the assertion doesn't care about the content is a cheap way to keep
 * the personal model from creeping back in as an unstated assumption.
 */

import type { DomainDef } from "../../src/types/config.js";

/**
 * A personal vocabulary — the shape OpenMemory is best at.
 *
 * Patterns match how facts are actually written: `capture_fact` is called by an
 * assistant recording a fact *about* its user, so content arrives in the third
 * person ("The user prefers dark roast"), not the first. Verbs need their -s
 * form — `\bprefer\b` does not match "prefers".
 */
export const PERSONAL_VOCABULARY: DomainDef[] = [
  {
    // First: a false positive on health is safer than a miss, and order is
    // precedence — the fallback stops at the first match.
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
      "\\b(my name is|i am|i'm|born|nationality|age|birthday|occupation|job title)\\b",
      "\\bi (live|lives) in\\b",
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

/**
 * A corporate vocabulary — nothing personal in it.
 *
 * Exists so tests can prove the engine has no opinion: the same code routes
 * `incidents` and calibrates a sev1 above everything, on names it has never
 * heard of.
 */
export const CORPORATE_VOCABULARY: DomainDef[] = [
  {
    name: "incidents",
    description: "outages, severities, postmortems",
    subdomains: [],
    patterns: ["\\b(incident|outage|sev\\d|postmortem|downtime)\\b"],
    importance: 0.95,
  },
  {
    name: "clients",
    description: "accounts, contracts, renewals",
    subdomains: [],
    patterns: ["\\b(client|account|contract|renewal|invoice)\\b"],
    importance: 0.7,
  },
  {
    name: "deployments",
    description: "releases, rollbacks, pipelines",
    subdomains: [],
    patterns: ["\\b(deploy|release|rollback|pipeline|migration)\\b"],
    importance: 0.6,
  },
];
