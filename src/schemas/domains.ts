/**
 * The domain taxonomy — the single definition of what domains exist.
 *
 * Every consumer reads from here: the LLM providers' prompts and output schema,
 * the heuristic fallback's keyword signals, the MCP tool descriptions, and the
 * validation gate in consolidation. Adding a domain is a change to this file
 * alone.
 *
 * It is centralised because the list had been copied into five places that
 * had already drifted apart — two of them listed `general` as a domain and
 * three did not. A taxonomy with no owner fragments silently, and a fact routed
 * to a domain nothing queries is invisible forever.
 */

export interface DomainDefinition {
  name: string;
  /** Guides an LLM's routing decision. Keep it one short clause. */
  description: string;
  /**
   * Keyword signals for the heuristic fallback, which runs when no LLM is
   * available. First match wins across domains in registry order, so a domain's
   * patterns should be specific enough not to poach another's facts.
   *
   * Patterns must match how facts are actually written. An AI captures facts
   * about its user in the third person ("The user prefers dark roast"), not the
   * first ("I prefer dark roast"), so verbs need their -s form: `prefers?`, not
   * `prefer`. `\bprefer\b` does not match "prefers".
   */
  patterns: RegExp[];
  subdomains: string[];
}

/** The domain a fact lands in when nothing else matches. */
export const DEFAULT_DOMAIN = "general";

/**
 * Registry order is match order for the heuristic fallback.
 *
 * Medical is first deliberately: health information takes priority, and a
 * false positive there is safer than a miss.
 *
 * Known limitation, unchanged by centralising this: first-match-wins produces
 * false positives like "prefers chatting with their doctor" → medical. A scored
 * classifier (rank all domains, tie-break by margin) would be more robust. The
 * LLM providers are the real classifier; this fallback only has to be adequate.
 */
export const DOMAINS: DomainDefinition[] = [
  {
    name: "medical",
    description: "health conditions, allergies, medication, treatment",
    patterns: [
      /\b(allerg|medicat|doctor|diagnosis|condition|symptom|treatment|prescription|health|hospital|clinic|vaccine|blood|surgery|therapy|illness|disease)/i,
    ],
    subdomains: [],
  },
  {
    name: "profile",
    description: "core identity — name, demographics, location, occupation",
    patterns: [
      // First person, as a user states it.
      /\b(my name is|i am|i'm|born|nationality|age|birthday|occupation|job title)\b/i,
      /\bi (live|lives) in\b/i,
      // Third person, as an AI records it about its user.
      /\bthe user('s)? (is|was|has been)? ?(called|named)\b/i,
      /\bthe user's (name|age|birthday|nationality|occupation|job title)\b/i,
      /\b(the user|they) (lives?|moved|grew up|was born)\b/i,
    ],
    subdomains: [],
  },
  {
    // Ahead of preferences deliberately: a relationship noun says who a fact is
    // about, which is a stronger signal than a preference verb says what it is.
    // "My partner Robin loves sushi" is a fact about Robin.
    //
    // This ordering used to be the other way round and appeared to work only by
    // accident — the preference pattern was `\blove\b`, which never matched
    // "loves", so the fact fell through to people. Fixing the verb forms exposed
    // the latent collision.
    name: "people",
    description: "relationships and the people in the user's life",
    patterns: [
      /\b(partner|wife|husband|friend|colleague|boss|sister|brother|mother|father|son|daughter|neighbour|neighbor)\b/i,
    ],
    subdomains: [],
  },
  {
    name: "preferences",
    description: "likes, dislikes, favourites, habits",
    patterns: [
      // -s forms included: "The user prefers X" is the shape a capture takes.
      /\b(prefers?|favourites?|favorites?|likes?|loves?|hates?|dislikes?|enjoys?|can't stand|would rather|rather)\b/i,
    ],
    subdomains: [],
  },
  {
    name: "work",
    description: "employment, projects, teams, deadlines",
    patterns: [
      /\b(project|sprint|deploy|meeting|team|company|client|deadline|standup|release|merge|repository|codebase)\b/i,
    ],
    subdomains: [],
  },
  {
    name: DEFAULT_DOMAIN,
    description: "anything that doesn't fit another domain",
    // No patterns: this is where a fact lands when nothing matches, never
    // something a fact matches into.
    patterns: [],
    subdomains: [],
  },
];

/** Every domain name, including `general`. */
export const DOMAIN_NAMES: string[] = DOMAINS.map((d) => d.name);

/** Domains a fact can be routed *to* by a classifier — excludes the fallback. */
export const ROUTABLE_DOMAIN_NAMES: string[] = DOMAINS.filter(
  (d) => d.name !== DEFAULT_DOMAIN,
).map((d) => d.name);

export function isKnownDomain(name: string): boolean {
  return DOMAIN_NAMES.includes(name.trim().toLowerCase());
}

/**
 * Coerce a domain from any source — an LLM, a caller's hint, the fallback — into
 * one the rest of the system queries.
 *
 * This is the gate. Providers return a free-form string, so without it an LLM
 * answering "health" instead of "medical", or "Preferences" capitalised, would
 * silently mint a new domain. Tools like `get_profile` query fixed names, so
 * those facts would be stored, reported in the stats, and never retrievable.
 * Unknown values land in `general`, where a keyword search can still reach them.
 */
export function normaliseDomain(name: string | null | undefined): string {
  if (!name) return DEFAULT_DOMAIN;
  const cleaned = name.trim().toLowerCase();
  return isKnownDomain(cleaned) ? cleaned : DEFAULT_DOMAIN;
}

/** Comma-separated list for prose: "profile, preferences, medical, people, work". */
export function routableDomainList(): string {
  return ROUTABLE_DOMAIN_NAMES.join(", ");
}

/** Pipe-separated list for a prompt's enum-style hint, including `general`. */
export function domainPromptList(): string {
  return DOMAIN_NAMES.join("|");
}

/** Domains with their descriptions, for prompting an LLM to route accurately. */
export function domainPromptGuide(): string {
  return DOMAINS.map((d) => `${d.name} (${d.description})`).join(", ");
}
