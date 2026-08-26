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
    const provider = createSamplingProvider(server, createHeuristicProvider(PERSONAL_VOCABULARY), PERSONAL_VOCABULARY);

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
    const provider = createSamplingProvider(server, createHeuristicProvider(PERSONAL_VOCABULARY), PERSONAL_VOCABULARY);

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
    const provider = createSamplingProvider(server, createHeuristicProvider(PERSONAL_VOCABULARY), PERSONAL_VOCABULARY);

    const result = await provider.classifyFacts([
      { id: "s1", content: "I'm allergic to aspirin", domain_hint: null } as any,
    ]);
    // Heuristic fallback routes medical keywords → medical domain.
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("medical");
  });

  it("extracts from an object payload including now and confidence", async () => {
    const server = makeServer({
      createMessage: vi.fn().mockResolvedValue({
        content: {
          type: "text",
          text: JSON.stringify({
            facts: [{ content: "Alex prefers oat milk at Acme.", domain_hint: "preferences" }],
            session_now: "beverage talk",
            referents: [{ phrase: "the drink", binding: "oat milk" }],
            topic_shifted: false,
            confidence: 0.9,
          }),
        },
      }),
    });
    const provider = createSamplingProvider(
      server,
      createHeuristicProvider(PERSONAL_VOCABULARY),
      PERSONAL_VOCABULARY,
    );
    const result = await provider.extractFactsFromEvents(
      [
        {
          role: "user",
          content: "oat milk",
          occurred_at: "2026-08-25T18:00:00.000Z",
        } as never,
      ],
      [],
    );
    expect(result.degraded).toBe(false);
    expect(result.facts[0].content).toMatch(/oat milk/);
    expect(result.now).toBe("beverage talk");
    expect(result.referents).toEqual([
      { phrase: "the drink", binding: "oat milk" },
    ]);
    expect(result.confidence).toBe(0.9);
    const prompt = (server.createMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0].systemPrompt as string;
    expect(prompt).toContain("CONTRADICTS long_term_memory");
    expect(prompt).toContain("Never guess a calendar day");
    expect(prompt).not.toMatch(/pronoun resolution/i);
    const userText = (server.createMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0].messages[0].content.text as string;
    const payload = JSON.parse(userText) as {
      extract_today: string;
      candidate_events: Array<{ said_at: string | null }>;
    };
    expect(payload.extract_today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.candidate_events[0].said_at).toBe("2026-08-25T18:00:00.000Z");
  });

  it("keeps a stated ISO valid_from and drops a hedge", async () => {
    const server = makeServer({
      createMessage: vi.fn().mockResolvedValue({
        content: {
          type: "text",
          text: JSON.stringify({
            facts: [
              {
                content: "The user went to the beach on 25 August 2026.",
                domain_hint: "profile",
                valid_from: "2026-08-25",
                valid_until: null,
              },
              {
                content: "The user worked in a bar when younger.",
                domain_hint: "work",
                valid_from: "about five years ago",
                valid_until: null,
              },
            ],
          }),
        },
      }),
    });
    const provider = createSamplingProvider(
      server,
      createHeuristicProvider(PERSONAL_VOCABULARY),
      PERSONAL_VOCABULARY,
    );
    const result = await provider.extractFactsFromEvents(
      [{ role: "user", content: "beach" } as never],
      [],
    );
    expect(result.facts[0].valid_from).toBe("2026-08-25T00:00:00.000Z");
    expect(result.facts[1].valid_from).toBeNull();
  });

  it("treats a legacy JSON array as facts-only", async () => {
    const server = makeServer({
      createMessage: vi.fn().mockResolvedValue({
        content: {
          type: "text",
          text: JSON.stringify([
            { content: "Alex prefers oat milk at Acme.", domain_hint: "preferences" },
          ]),
        },
      }),
    });
    const provider = createSamplingProvider(
      server,
      createHeuristicProvider(PERSONAL_VOCABULARY),
      PERSONAL_VOCABULARY,
    );
    const result = await provider.extractFactsFromEvents(
      [{ role: "user", content: "oat milk" } as never],
      [],
    );
    expect(result.degraded).toBe(false);
    expect(result.facts).toHaveLength(1);
    expect(result.now).toBeUndefined();
    expect(result.confidence).toBeUndefined();
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
    const provider = createSamplingProvider(server, createHeuristicProvider(PERSONAL_VOCABULARY), PERSONAL_VOCABULARY);

    const result = await provider.classifyFacts([
      { id: "s1", content: "I like tea", domain_hint: null } as any,
    ]);
    expect(result[0].domain).toBe("preferences");
    expect(result[0].subdomain).toBe("beverage");
  });
});
import { PERSONAL_VOCABULARY } from "../fixtures/vocabulary.js";
import { createHeuristicProvider } from "../../src/intelligence/heuristic.js";
