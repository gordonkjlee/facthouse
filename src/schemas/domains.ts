/**
 * Domain mechanics. **The engine ships no vocabulary.**
 *
 * There is exactly one built-in domain: `general`, the fallback a fact lands in
 * when nothing routes it. Everything else — which domains exist, what they mean,
 * how the fallback classifier recognises them, how important their facts are —
 * is data, supplied by the user's config and grown at runtime by whatever
 * classifies.
 *
 * This file used to hold five domains called CORE: profile, preferences,
 * medical, people, work. That was a personal vocabulary presented as a universal
 * base, and it does not survive the question "what does a corporate user do with
 * `medical`, and what does `work` mean when everything is work?" It doesn't. A
 * research store wants papers, experiments, datasets; a corporate one wants
 * clients, incidents, contracts. There is no universal core — and the word
 * "core" was what disguised a preset as an invariant.
 *
 * The data model said so before any of this was written:
 *
 *   > Domains are data, not code. [...] No prescribed defaults. The user's LLM
 *   > knows their life better than we do.
 *
 * What stays here is the machinery that is genuinely universal: the fallback
 * domain, canonicalisation, and the instruction that steers a classifier toward
 * the vocabulary that already exists rather than coining a synonym for it.
 */

import type { DomainDef } from "../types/config.js";

/**
 * Where a fact lands when nothing routes it.
 *
 * The only domain the engine knows by name. It is a fallback, never a
 * destination: nothing routes *to* general, facts arrive there by default.
 */
export const DEFAULT_DOMAIN = "general";

/**
 * Canonicalise a domain's spelling — case and whitespace only.
 *
 * Deliberately does not coerce an unrecognised domain into the fallback: with no
 * shipped vocabulary, "unrecognised" is the normal case and every domain is
 * someone's. The label a classifier chose is the most informative thing about a
 * fact that fits nothing else; discarding it is the lossy step.
 *
 * What it does prevent is one domain existing twice under different spellings —
 * `Preferences` and `preferences` are one domain, not two.
 */
export function normaliseDomainName(name: string | null | undefined): string {
  if (!name) return DEFAULT_DOMAIN;
  const cleaned = name.trim().toLowerCase().replace(/\s+/g, "_");
  return cleaned === "" ? DEFAULT_DOMAIN : cleaned;
}

/** Names from a configured vocabulary, canonicalised, excluding the fallback. */
export function routableNames(vocabulary: DomainDef[]): string[] {
  return vocabulary
    .map((d) => normaliseDomainName(d.name))
    .filter((n) => n !== DEFAULT_DOMAIN);
}

/** Comma-separated routable names for prose. Empty when none are configured. */
export function routableDomainList(vocabulary: DomainDef[]): string {
  return routableNames(vocabulary).join(", ");
}

/**
 * Compile a configured vocabulary into matchers for the fallback classifier.
 *
 * Order is the vocabulary's order: first match wins, so whoever writes the
 * config decides precedence. Domains without patterns are skipped — only an LLM
 * can route to those.
 *
 * An invalid regex is dropped rather than thrown: a typo in one domain's config
 * must not stop the server booting. The cost is that one domain routing poorly,
 * rather than nothing working at all.
 */
export function compilePatterns(
  vocabulary: DomainDef[],
): Array<{ name: string; patterns: RegExp[] }> {
  const compiled: Array<{ name: string; patterns: RegExp[] }> = [];
  for (const domain of vocabulary) {
    const name = normaliseDomainName(domain.name);
    if (name === DEFAULT_DOMAIN || !domain.patterns?.length) continue;
    const patterns: RegExp[] = [];
    for (const source of domain.patterns) {
      try {
        patterns.push(new RegExp(source, "i"));
      } catch {
        console.error(
          `[factmem] ignoring an invalid pattern for domain "${name}": ${source}`,
        );
      }
    }
    if (patterns.length) compiled.push({ name, patterns });
  }
  return compiled;
}

/** Importance defaults declared by a vocabulary, keyed by canonical name. */
export function importanceDefaults(
  vocabulary: DomainDef[],
): Record<string, number> {
  const defaults: Record<string, number> = {};
  for (const domain of vocabulary) {
    if (typeof domain.importance === "number") {
      defaults[normaliseDomainName(domain.name)] = domain.importance;
    }
  }
  return defaults;
}

/**
 * The routing instruction given to a classifier.
 *
 * `known` is the vocabulary that exists in this store right now — the config's
 * domains plus anything previously created. Naming it is what keeps the
 * vocabulary stable: a classifier shown "medical" reuses it instead of coining
 * "health", the drift that scatters related facts across synonyms. Reuse is
 * steered by showing what exists, never by forbidding new labels — with no
 * shipped vocabulary, forbidding them would mean routing nothing at all.
 */
/**
 * One vocabulary for routing: domains the store already created, overlaid
 * with config (importance, description, patterns). Config-only names are
 * appended. Canonical name is the key — `Warehouse` and `warehouse` are one.
 *
 * Extract and classify must call this (via `loadStoreVocabulary`) rather than
 * reading `config.domains` alone. Config defaults to `[]`, so a used store
 * would otherwise be told it has no domains and would coin synonyms.
 */
export function mergeVocabulary(
  fromStore: DomainDef[],
  fromConfig: DomainDef[] = [],
): DomainDef[] {
  const byName = new Map<string, DomainDef>();
  for (const d of fromStore) {
    const name = normaliseDomainName(d.name);
    byName.set(name, { ...d, name });
  }
  for (const d of fromConfig) {
    const name = normaliseDomainName(d.name);
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, { ...d, name });
      continue;
    }
    byName.set(name, {
      ...existing,
      description: d.description ?? existing.description,
      patterns: d.patterns ?? existing.patterns,
      importance: d.importance ?? existing.importance,
      subdomains:
        existing.subdomains.length > 0 ? existing.subdomains : d.subdomains,
    });
  }
  return [...byName.values()];
}

export function domainRoutingInstruction(known: DomainDef[] = []): string {
  const described = known
    .map((d) => {
      const name = normaliseDomainName(d.name);
      return { name, text: d.description ? `${name} (${d.description})` : name };
    })
    .filter((d) => d.name !== DEFAULT_DOMAIN)
    .map((d) => d.text);

  const vocabulary = described.length
    ? `Domains already in use — reuse the exact spelling where one fits: ${described.join(", ")}. `
    : `This store has no domains yet; you are choosing its vocabulary. `;

  return (
    `Route each fact to one domain. ${vocabulary}` +
    `Invent a new domain only when the fact genuinely fits none of them; if you ` +
    `do, use a short lowercase noun. Never coin a synonym for a domain above. ` +
    `Use "${DEFAULT_DOMAIN}" only when a fact belongs to no domain at all.`
  );
}
