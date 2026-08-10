/**
 * Identifying what a fact is *about*.
 *
 * Every fact→entity link the engine writes is a mention. That is enough to find
 * a fact from a name, and not enough to answer "what do you know about X" —
 * "Robin approved Alex's transfer" mentions both and is about neither in the
 * way a reader would mean.
 *
 * Subject identification in general needs a language model: whether "Alex likes
 * coffee" is about the user or about a friend depends on who Alex is. But one
 * case is decidable without one, and it happens to be the most common case in
 * this store.
 *
 * An assistant recording something about its user writes in the third person —
 * "The user prefers dark mode", not "I prefer dark mode". That phrasing was
 * already the source of a shipped bug: the domain classifier matched
 * `\bprefer\b` while real content said "prefers", so identity and preference
 * facts silently fell to the fallback domain. The tests shared the mistaken
 * premise, so they agreed with the code and both were wrong about reality.
 *
 * The same phrasing that caused that bug is what makes this determinable. When
 * a fact opens by naming the user as its grammatical subject, its subject is
 * the user, and no model is needed to say so.
 */

/**
 * Does this fact state something about the user, with the user as its subject?
 *
 * Deliberately narrow. It matches a leading "the user" or "user" followed by a
 * verb, and nothing else — no pronouns, no first person, no possessives.
 *
 * The possessive exclusion is the important one. "The user's colleague Robin is
 * leading Atlas" is about Robin; the user appears only to locate him. Requiring
 * whitespace after `user` excludes `user's` without a special case, because an
 * apostrophe is not whitespace.
 *
 * Declining is the correct answer for everything else. A wrong subject is worse
 * than no subject: an absent link leaves a fact findable by mention, whereas a
 * misattributed one files someone else's fact under the user and there is
 * nothing downstream to catch it.
 */
export function isAboutTheUser(content: string): boolean {
  return /^\s*(?:the\s+)?user\s+\S/i.test(content);
}
