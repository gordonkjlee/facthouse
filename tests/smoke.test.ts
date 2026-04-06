import { describe, it, expect } from "vitest";
import { DEFAULT_IMPORTANCE } from "../src/types/index.js";
import type { DomainDef } from "../src/types/index.js";

describe("smoke test", () => {
  it("exports DEFAULT_IMPORTANCE", () => {
    expect(DEFAULT_IMPORTANCE).toBe(0.5);
  });

  it("DomainDef is structurally valid", () => {
    const domain: DomainDef = { name: "custom-domain", subdomains: ["sub-a", "sub-b"] };
    expect(domain.name).toBe("custom-domain");
    expect(domain.subdomains).toHaveLength(2);
  });
});
