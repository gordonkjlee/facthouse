/**
 * The domain taxonomy — core definitions, and the rules for extending beyond them.
 *
 * The model is **core plus periphery**:
 *
 *   - A small **core** (profile, preferences, medical, people, work) is defined
 *     here and seeded on init. The read tools and the fallback classifier depend
 *     on these exact names, and a schema needs to pre-exist for a new fact to be
 *     judged congruent with it — an empty vocabulary gives a classifier nothing
 *     to be consistent with.
 *   - An open **periphery**: the calling LLM or a user's config may create any
 *     other domain, and the server records it. The user's own assistant knows
 *     their life better than a fixed list does, and which categories are worth
 *     having is personal — an expert's categories in their own field are as
 *     sharp as anyone's basic-level ones.
 *
 * This file is the single definition of the core. Every consumer derives from
 * it: the providers' prompts, the fallback's keyword signals, and the tool
 * descriptions. The list previously lived in five places that had already
 * drifted — two called `general` a domain and three did not.
 *
 * **A domain is a hint, not a gate.** An unrecognised domain is never discarded
 * or coerced into a bucket: it is recorded as given. Labels are unstable by
 * nature — a classifier may answer "health" one run and "medical" the next,
 * exactly as human categorisers disagree with themselves on borderline items —
 * so nothing that must be retrievable may depend on the label matching exactly.
 * See docs/design/data-model.md § Domains.
 */

export interface DomainDefinition {
  name: string;
  /** Guides a classifier's routing decision. Keep it one short clause. */
  description: string;
  /**
   * Keyword signals for the heuristic fallback, which runs when no LLM is
   * available. First match wins across domains in registry order.
   *
   * Patterns must match how facts are actually written. `capture_fact` is called
   * by an assistant recording a fact about its user, so content arrives in the
   * third person ("The user prefers dark roast"), not the first ("I prefer dark
   * roast"). Verbs therefore need their -s form: `prefers?`, not `prefer` —
   * `\bprefer\b` does not match "prefers".
   *
   * Periphery domains have no patterns: the fallback cannot invent keywords for
   * a domain it has never heard of, so only an LLM can route to them.
   */
  patterns: RegExp[];
  subdomains: string[];
  /**
   * Default importance for a fact in this domain, when nothing better says.
   *
   * Resolution order is: the calling assistant's explicit value, then a
   * provider's signal, then this, then 0.5. This layer existed in the spec and
   * in the config type but shipped empty, so in practice everything scored 0.5 —
   * "The user is called Alex Rivera" ranked exactly level with "Minor trivial
   * detail". Ranked retrieval is the escape from gating on a label, and it is a
   * no-op while every key is identical.
   *
   * Calibrated against what capture_fact already tells assistants: "High for
   * medical/safety, low for casual preferences."
   */
  importance: number;
}

/** Where a fact lands when no core pattern matches and no classifier routed it. */
export const DEFAULT_DOMAIN = "general";

/**
 * The core, seeded on init. Registry order is match order for the fallback.
 *
 * Medical is first deliberately: health information takes priority, and a false
 * positive there is safer than a miss.
 *
 * Known limitation: first-match-wins produces false positives like "prefers
 * chatting with their doctor" → medical. A scored classifier (rank all domains,
 * tie-break by margin) would be more robust. The LLM providers are the real
 * classifier; this fallback only has to be adequate.
 */
export const CORE_DOMAINS: DomainDefinition[] = [
  {
    name: "medical",
    description: "health conditions, allergies, medication, treatment",
    patterns: [
      /\b(allerg|medicat|doctor|diagnosis|condition|symptom|treatment|prescription|health|hospital|clinic|vaccine|blood|surgery|therapy|illness|disease)/i,
    ],
    subdomains: [],
    importance: 0.9, // safety information; a missed allergy is the costliest error here
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
    importance: 0.85, // identity is what every conversation is grounded in
  },
  {
    // Ahead of preferences deliberately: a relationship noun says who a fact is
    // about, which outranks a preference verb saying what it mentions. "My
    // partner Robin loves sushi" is a fact about Robin.
    name: "people",
    description: "relationships and the people in the user's life",
    patterns: [
      /\b(partner|wife|husband|friend|colleague|boss|sister|brother|mother|father|son|daughter|neighbour|neighbor)\b/i,
    ],
    subdomains: [],
    importance: 0.6, // relationships matter, but a given fact about someone rarely decides an answer
  },
  {
    name: "preferences",
    description: "likes, dislikes, favourites, habits",
    patterns: [
      /\b(prefers?|favourites?|favorites?|likes?|loves?|hates?|dislikes?|enjoys?|can't stand|would rather|rather)\b/i,
    ],
    subdomains: [],
    importance: 0.4, // the point of the product, and individually low-stakes — a wrong coffee is recoverable
  },
  {
    name: "work",
    description: "employment, projects, teams, deadlines",
    patterns: [
      /\b(project|sprint|deploy|meeting|team|company|client|deadline|standup|release|merge|repository|codebase)\b/i,
    ],
    subdomains: [],
    importance: 0.6, // consequential in context, rarely urgent out of it
  },
  {
    name: DEFAULT_DOMAIN,
    description: "anything that doesn't fit another domain",
    // No patterns: this is where a fact lands when nothing matches, never
    // something a fact matches into.
    patterns: [],
    subdomains: [],
    importance: 0.5, // by definition uncategorised, so it gets the neutral baseline
  },
];

/** Core domain names, including the fallback. */
export const CORE_DOMAIN_NAMES: string[] = CORE_DOMAINS.map((d) => d.name);

/** Core domains a classifier should route *to* — excludes the fallback. */
export const ROUTABLE_CORE_NAMES: string[] = CORE_DOMAINS.filter(
  (d) => d.name !== DEFAULT_DOMAIN,
).map((d) => d.name);

/** Is this one of the domains the read tools and fallback patterns depend on? */
export function isCoreDomain(name: string): boolean {
  return CORE_DOMAIN_NAMES.includes(normaliseDomainName(name));
}

/**
 * Canonicalise a domain's spelling — case and whitespace only.
 *
 * This deliberately does **not** coerce an unrecognised domain into `general`.
 * The taxonomy is open beyond the core: "fitness" or "finance" from a user's own
 * assistant is a domain worth keeping, and a sink that discards the label the
 * classifier produced destroys exactly the information that made the fact
 * distinctive. Novel categories are the ones worth encoding distinctly, not the
 * ones worth flattening.
 *
 * What it does prevent is the same domain existing twice under different
 * spellings — `Preferences` and `preferences` are one domain, not two.
 */
export function normaliseDomainName(name: string | null | undefined): string {
  if (!name) return DEFAULT_DOMAIN;
  const cleaned = name.trim().toLowerCase().replace(/\s+/g, "_");
  return cleaned === "" ? DEFAULT_DOMAIN : cleaned;
}

/** Comma-separated core names for prose: "profile, preferences, ...". */
export function routableDomainList(): string {
  return ROUTABLE_CORE_NAMES.join(", ");
}

/** Pipe-separated core names, including the fallback. */
export function domainPromptList(): string {
  return CORE_DOMAIN_NAMES.join("|");
}

/** Core domains with descriptions, for prompting a classifier to route accurately. */
export function domainPromptGuide(): string {
  return CORE_DOMAINS.map((d) => `${d.name} (${d.description})`).join(", ");
}

/**
 * The routing instruction given to an LLM.
 *
 * `known` is the vocabulary that already exists in this store — the core plus
 * anything previously created. Naming it is what keeps the vocabulary stable:
 * a classifier shown "medical" reuses it instead of coining "health", which is
 * the drift that scatters related facts. Reuse is steered by telling the model
 * what exists, not by forbidding new labels.
 */
export function domainRoutingInstruction(known: string[] = []): string {
  const vocabulary = Array.from(new Set([...CORE_DOMAIN_NAMES, ...known]));
  return (
    `Route each fact to one domain. Prefer an existing domain — reuse the exact ` +
    `spelling: ${vocabulary.join(", ")}. ` +
    `Core domains are ${domainPromptGuide()}. ` +
    `Only invent a new domain when the fact genuinely fits none of them; if you ` +
    `do, use a short lowercase noun. Never coin a synonym for a domain above.`
  );
}
