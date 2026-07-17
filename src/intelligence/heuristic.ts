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
  DEFAULT_DOMAIN,
  compilePatterns,
  normaliseDomainName,
} from "../schemas/domains.js";
import type { DomainDef } from "../types/config.js";

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

/**
 * Classify a single content string into a domain, using the vocabulary this
 * store was configured with.
 *
 * The engine knows no domain names. `matchers` comes from the user's config —
 * personal, corporate, whatever they wrote. With none configured, everything
 * lands in the fallback, which is the honest answer: a keyword classifier with
 * no keywords cannot route, and inventing a vocabulary here is what made this
 * a personal-only product.
 */
function classifyContent(
  content: string,
  domainHint: string | null,
  matchers: Array<{ name: string; patterns: RegExp[] }>,
): { domain: string; subdomain: string | null } {
  // Explicit hint takes priority
  // A hint is honoured as given, including a domain outside the core — the
  // taxonomy is open. Only its spelling is canonicalised.
  if (domainHint) {
    return { domain: normaliseDomainName(domainHint), subdomain: null };
  }

  // Vocabulary order is match order; first match wins, so whoever wrote the
  // config decides precedence.
  for (const { name, patterns } of matchers) {
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

/**
 * Entity extraction needs an LLM. This provider has none, so it extracts nothing.
 *
 * It used to match `my (partner|wife|husband|sister|...) Alice` and map the
 * keyword to an edge label — partner_of, parent_of, child_of. That is a personal
 * ontology hardcoded into a general engine: a corporate store's relationships are
 * supplier, account manager, on-call, escalation contact, and no fixed list
 * covers both. Guessing at one was the same mistake as shipping a domain
 * vocabulary, on a different axis.
 *
 * Returning nothing is the honest answer. An LLM provider — the default — does
 * this from the content, with no list to be wrong about.
 */
function extractFromContent(_content: string): ExtractedEntity[] {
  return [];
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
// Provider implementation
// ---------------------------------------------------------------------------

export function createHeuristicProvider(
  /** The store's configured vocabulary. Empty means everything routes to the fallback. */
  vocabulary: DomainDef[] = [],
): IntelligenceProvider {
  const matchers = compilePatterns(vocabulary);
  return {
    async classifyFacts(facts, _sessionContext) {
      return facts.map((f) => {
        const { domain, subdomain } = classifyContent(f.content, f.domain_hint, matchers);
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

    async extractFactsFromEvents() {
      // Extracting facts from raw conversation needs an LLM. This provider has
      // none, so it extracts nothing.
      //
      // It used to match "my name is", "I'm allergic to", "I prefer", "I live
      // in" — a personal ontology, in first person, hardcoded. It finds nothing
      // in a corporate store's "the sev1 postmortem is due Friday", and any list
      // that did would be wrong for someone else. Explicit capture_fact is
      // unaffected; this path just requires intelligence to do intelligent work.
      return [];
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
