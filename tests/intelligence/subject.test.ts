import { describe, it, expect } from "vitest";

const { isAboutTheUser } = await import("../../src/intelligence/subject.js");

/**
 * These fixture strings are what an assistant actually emits, not what a person
 * would write about themselves. That distinction has already cost this codebase
 * one shipped bug: the domain classifier matched first-person phrasing while
 * real content arrived in the third person, and every test shared the same
 * mistaken premise, so they agreed with the code and both were wrong.
 */
describe("isAboutTheUser", () => {
  it("recognises the third-person phrasing an assistant writes", () => {
    expect(isAboutTheUser("The user prefers dark mode in all editors.")).toBe(true);
    expect(isAboutTheUser("The user is allergic to shellfish.")).toBe(true);
    expect(isAboutTheUser("User works at Acme.")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isAboutTheUser("the user prefers tea")).toBe(true);
    expect(isAboutTheUser("  The User Prefers Tea")).toBe(true);
  });

  it("declines a fact about somebody else", () => {
    expect(isAboutTheUser("Robin leads the Atlas migration.")).toBe(false);
    expect(isAboutTheUser("Acme is headquartered in Bristol.")).toBe(false);
  });

  it("declines a possessive, which shifts the subject to someone else", () => {
    // "The user's colleague Robin is leading Atlas" is about Robin — the user
    // appears only to locate him. Attributing it to the user would file Robin's
    // fact under the wrong subject, and nothing downstream would catch it.
    expect(isAboutTheUser("The user's colleague Robin is leading Atlas.")).toBe(false);
    expect(isAboutTheUser("The user's partner is called Alex.")).toBe(false);
  });

  it("declines first person, which is not how facts are recorded here", () => {
    // A human writes this; an assistant recording a fact does not. Matching it
    // would mean guessing at raw conversational text that has not been through
    // extraction yet.
    expect(isAboutTheUser("I prefer dark mode")).toBe(false);
    expect(isAboutTheUser("my partner is called Alex")).toBe(false);
  });

  it("declines a bare or truncated mention with no predicate", () => {
    // "user" alone asserts nothing, so there is no fact to attribute.
    expect(isAboutTheUser("user")).toBe(false);
    expect(isAboutTheUser("The user")).toBe(false);
    expect(isAboutTheUser("")).toBe(false);
  });

  it("declines a word that merely begins with 'user'", () => {
    expect(isAboutTheUser("username collisions are handled at capture")).toBe(false);
    expect(isAboutTheUser("Users of the API must authenticate")).toBe(false);
  });
});
