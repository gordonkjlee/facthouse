/**
 * Heuristic intelligence provider.
 * Keyword/regex-based, zero LLM dependencies.
 * Quality is limited but cost is zero and it always works.
 */

import type {
  IntelligenceProvider,
  ExtractedEntity,
} from "./types.js";
import {
  CORE_DOMAINS,
  DEFAULT_DOMAIN,
  normaliseDomainName,
} from "../schemas/domains.js";

// ---------------------------------------------------------------------------
// Shared normalisation
// ---------------------------------------------------------------------------

/** Normalise fact content for dedup comparison. Lowercase, trim, strip trailing
 *  punctuation, collapse whitespace. Used by both intra-batch dedup (consolidate.ts)
 *  and cross-batch reconcile (this file). */
export function normaliseForDedup(content: string): string {
  return content
    .toLowerCase()
    .trim()
    .replace(/[.,;:!?]+$/, "")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Domain classification keywords
// ---------------------------------------------------------------------------

/** Classify a single content string into a domain. */
function classifyContent(content: string, domainHint: string | null): { domain: string; subdomain: string | null } {
  // Explicit hint takes priority
  // A hint is honoured as given, including a domain outside the core — the
  // taxonomy is open. Only its spelling is canonicalised.
  if (domainHint) {
    return { domain: normaliseDomainName(domainHint), subdomain: null };
  }

  // Registry order is match order; first match wins. Only core domains have
  // patterns — the fallback cannot route to a periphery domain it has never
  // seen, so those require an LLM classifier.
  for (const { name, patterns } of CORE_DOMAINS) {
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return { domain: name, subdomain: null };
      }
    }
  }

  return { domain: DEFAULT_DOMAIN, subdomain: null };
}

// ---------------------------------------------------------------------------
// Entity extraction patterns
// ---------------------------------------------------------------------------

// Person entity patterns only. Place/org extraction requires NER or more complex patterns.
// "[Mm]y" (not the /i flag) handles sentence-initial "My partner Alice" without
// making [A-Z][a-z]+ case-insensitive — otherwise the name group would greedily
// swallow trailing words (e.g. "Robin loves" instead of "Robin").
const NAME_PATTERNS = [
  /\b[Mm]y (?:partner|wife|husband|friend|colleague|boss|sister|brother|mother|father|son|daughter|neighbour|neighbor)\s+(?:is\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+is\s+[Mm]y\s+(?:partner|wife|husband|friend|colleague|boss|sister|brother|mother|father|son|daughter|neighbour|neighbor)/g,
];

// Maps a relationship keyword to the edge label describing the EXTRACTED entity.
// "my mother Alice" → Alice is a parent, so mother → parent_of.
// "my son Bob" → Bob is a child, so son → child_of.
const RELATIONSHIP_MAP: Record<string, string> = {
  partner: "partner_of",
  wife: "partner_of",
  husband: "partner_of",
  friend: "friend_of",
  colleague: "works_with",
  boss: "reports_to",
  sister: "sibling_of",
  brother: "sibling_of",
  mother: "parent_of",
  father: "parent_of",
  son: "child_of",
  daughter: "child_of",
  neighbour: "neighbour_of",
  neighbor: "neighbour_of",
};

/** Extract entities from a single content string. */
function extractFromContent(content: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  for (const pattern of NAME_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1]?.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());

      // Extract relationship from the matched text, not the full content
      let relationship = "mentioned_in";
      const matchText = match[0].toLowerCase();
      for (const [keyword, rel] of Object.entries(RELATIONSHIP_MAP)) {
        if (matchText.includes(keyword)) {
          relationship = rel;
          break;
        }
      }

      entities.push({ name, type: "person", relationship });
    }
  }

  return entities;
}

// ---------------------------------------------------------------------------
// Supersession detection
// ---------------------------------------------------------------------------

// Common stop words excluded from similarity comparisons to avoid spurious
// overlap from function words ("I", "the", "a", "to", etc.).
const STOP_WORDS = new Set([
  "i", "me", "my", "mine", "myself", "you", "your", "yours",
  "a", "an", "the", "is", "am", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "as",
  "and", "or", "but", "not", "no", "do", "does", "did", "have", "has", "had",
  "it", "this", "that", "these", "those", "will", "would", "should", "could",
  // Transition / substitution markers — present in supersession phrasing
  // ("I now prefer X instead of Y") but carry no content-similarity signal.
  "now", "instead",
]);

function tokenise(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => !STOP_WORDS.has(w)),
  );
}

/** Compute Jaccard similarity of content-word sets (stop words excluded). */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = tokenise(a);
  const wordsB = tokenise(b);
  if (wordsA.size === 0 && wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Reliable logical-negation markers only. "switched"/"changed" removed because
// they misfire on routine work-domain text ("I changed jobs", "I switched desks").
const NEGATION_WORDS = /\b(not|no longer|don't|doesn't|stopped|quit|now prefer|instead)\b/i;

// Minimum Jaccard overlap (content-word tokens, stop words excluded) required
// to consider two facts as candidates for supersession. Empirically tuned;
// known to false-positive on unrelated preferences that share "prefer"/"roast"
// (see tests/intelligence/heuristic.test.ts for the known-limitation case).
const SUPERSESSION_JACCARD_MIN = 0.3;

// ---------------------------------------------------------------------------
// Fact extraction from events (D→I)
// ---------------------------------------------------------------------------

const EVENT_FACT_PATTERNS = [
  /\bmy name is\s+(.+?)(?:\.|,|$)/i,
  /\bi(?:'m| am) allergic to\s+(.+?)(?:\.|,|$)/i,
  /\bi prefer\s+(.+?)(?:\.|,|$)/i,
  // "I am a/an" removed — too greedy in conversational text. "I am a bit tired"
  // or "I'm a fan of this approach but..." would extract garbage facts.
  /\bi live in\s+(.+?)(?:\.|,|$)/i,
  /\bmy (?:partner|wife|husband|friend)\s+(?:is\s+)?([A-Z][a-z]+)/i,
];

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export function createHeuristicProvider(): IntelligenceProvider {
  return {
    async classifyFacts(facts, _sessionContext) {
      return facts.map((f) => {
        const { domain, subdomain } = classifyContent(f.content, f.domain_hint);
        return {
          id: f.id,
          content: f.content,
          domain,
          subdomain,
        };
      });
    },

    async extractEntities(facts) {
      const result = new Map<string, ExtractedEntity[]>();
      for (const fact of facts) {
        const entities = extractFromContent(fact.content);
        if (entities.length > 0) {
          result.set(fact.id, entities);
        }
      }
      return result;
    },

    async extractFactsFromEvents(
      events,
      _workingMemory,
      _sessionSummary,
      _longTermMemory,
    ) {
      const extracted: Array<{
        content: string;
        domain_hint: string | null;
        source_quality: "heuristic";
      }> = [];

      for (const event of events) {
        if (!event.content || event.content.length < 10) continue;
        if (event.role !== "user" && event.role !== "assistant") continue;

        for (const pattern of EVENT_FACT_PATTERNS) {
          const match = pattern.exec(event.content);
          if (match) {
            // Use the matched phrase, not the full event text (reduces noise)
            const factContent = match[0];
            const { domain } = classifyContent(factContent, null);
            extracted.push({
              content: factContent,
              domain_hint: domain !== "general" ? domain : null,
              source_quality: "heuristic",
            });
            break; // One fact per event for the heuristic provider
          }
        }
      }

      return extracted;
    },

    // Known limitation: location-change supersession ("I moved to Porto"
    // should supersede "I live in Lisbon") is invisible here — no negation
    // marker, minimal word overlap. Requires semantic reasoning (LLM provider).
    async detectSupersession(newFact, existingFacts) {
      for (const existing of existingFacts) {
        if (existing.domain !== newFact.domain) continue;
        if (existing.status !== "active" || !existing.is_latest) continue;

        const similarity = jaccardSimilarity(newFact.content, existing.content);

        // Supersession requires negation signal + word overlap + different content
        const hasNegation = NEGATION_WORDS.test(newFact.content);
        const contentDiffers = newFact.content.toLowerCase() !== existing.content.toLowerCase();

        if (similarity >= SUPERSESSION_JACCARD_MIN && contentDiffers && hasNegation) {
          return {
            existingFactId: existing.id,
            reason: `High word overlap (${(similarity * 100).toFixed(0)}%) with contradictory signal`,
          };
        }
      }
      return null;
    },

    async reconcile(candidate, existingFacts) {
      if (existingFacts.length === 0) return { kind: "add" };

      // Uses the same normalisation as intra-batch dedup in consolidate.ts so
      // "I prefer coffee" and "I prefer coffee." are consistently deduplicated.
      // The heuristic provider only distinguishes noop vs add — 'enrich' requires
      // semantic paraphrase detection which only the LLM providers do.
      const needle = normaliseForDedup(candidate.content);
      const dupe = existingFacts.find((f) => normaliseForDedup(f.content) === needle);
      return dupe ? { kind: "noop" } : { kind: "add" };
    },

    async summarise(facts, graduatedFacts, priorSummary) {
      if (graduatedFacts.length === 0) {
        // Empty run: keep the prior rolling summary verbatim if it exists.
        return {
          summary: priorSummary ?? "No facts graduated.",
          openThreads: [],
        };
      }

      // Count by actual classified domain (from graduated facts, not hints)
      const domains = new Map<string, number>();
      for (const f of graduatedFacts) {
        domains.set(f.domain, (domains.get(f.domain) ?? 0) + 1);
      }

      const domainList = [...domains.entries()]
        .map(([d, n]) => `${d} (${n})`)
        .join(", ");

      const previews = graduatedFacts
        .slice(0, 3)
        .map((f) => f.content.length > 60 ? f.content.slice(0, 60) + "…" : f.content)
        .join("; ");

      // Heuristic can't merge prior + new narratively. Concatenate as a crude
      // rolling summary — the LLM-backed providers do this properly.
      const newPart = `Graduated ${graduatedFacts.length} facts across domains: ${domainList}. Key topics: ${previews}.`;
      const summary = priorSummary
        ? `${priorSummary} ${newPart}`
        : newPart;
      return {
        summary,
        openThreads: [],
      };
    },
  };
}
