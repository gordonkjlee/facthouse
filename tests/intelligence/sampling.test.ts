import { describe, it, expect, vi } from "vitest";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createSamplingProvider } from "../../src/intelligence/sampling.js";

// Minimal Server stub — only the methods the sampling provider touches.
function makeServer(overrides: Partial<Record<string, any>>): Server {
  const stub = {
    getClientCapabilities: () => ({ sampling: {} }),
    createMessage: vi.fn(),
    ...overrides,
  };
  return stub as unknown as Server;
}

describe("sampling intelligence provider", () => {
  it("falls back to heuristic when client does not support sampling", async () => {
    const server = makeServer({
      getClientCapabilities: () => ({}), // no sampling field
      createMessage: vi.fn(),
    });
    const provider = createSamplingProvider(server, createHeuristicProvider(STARTER_VOCABULARY), STARTER_VOCABULARY);

    const decision = await provider.reconcile(
      { id: "s1", content: "I prefer coffee" } as any,
      [{ id: "f1", content: "I prefer coffee" } as any],
    );
    // Heuristic fallback normalises and dedupes — identical content returns noop.
    expect(decision.kind).toBe("noop");
    expect((server.createMessage as any)).not.toHaveBeenCalled();
  });

  it("falls back when createMessage throws", async () => {
    const server = makeServer({
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage: vi.fn().mockRejectedValue(new Error("transport error")),
    });
    const provider = createSamplingProvider(server, createHeuristicProvider(STARTER_VOCABULARY), STARTER_VOCABULARY);

    const decision = await provider.reconcile(
      { id: "s1", content: "something new" } as any,
      [{ id: "f1", content: "something old" } as any],
    );
    // Heuristic: different normalised content → add.
    expect(decision.kind).toBe("add");
    expect((server.createMessage as any)).toHaveBeenCalledTimes(1);
  });

  it("falls back when createMessage returns malformed JSON", async () => {
    const server = makeServer({
      createMessage: vi.fn().mockResolvedValue({
        content: { type: "text", text: "sorry I don't speak JSON" },
      }),
    });
    const provider = createSamplingProvider(server, createHeuristicProvider(STARTER_VOCABULARY), STARTER_VOCABULARY);

    const result = await provider.classifyFacts([
      { id: "s1", content: "I'm allergic to aspirin", domain_hint: null } as any,
    ]);
    // Heuristic fallback routes medical keywords → medical domain.
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("medical");
  });

  it("uses sampling result when it parses cleanly", async () => {
    const server = makeServer({
      createMessage: vi.fn().mockResolvedValue({
        content: {
          type: "text",
          text: JSON.stringify([
            { id: "s1", domain: "preferences", subdomain: "beverage" },
          ]),
        },
      }),
    });
    const provider = createSamplingProvider(server, createHeuristicProvider(STARTER_VOCABULARY), STARTER_VOCABULARY);

    const result = await provider.classifyFacts([
      { id: "s1", content: "I like tea", domain_hint: null } as any,
    ]);
    expect(result[0].domain).toBe("preferences");
    expect(result[0].subdomain).toBe("beverage");
  });
});
import { STARTER_VOCABULARY } from "../../src/schemas/starter-vocabulary.js";
import { createHeuristicProvider } from "../../src/intelligence/heuristic.js";
