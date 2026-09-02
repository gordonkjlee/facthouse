import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock child_process.spawn before importing the module under test
// ---------------------------------------------------------------------------

interface MockStdin extends EventEmitter {
  end: (chunk?: string, encoding?: string) => void;
  write: (chunk: string) => boolean;
}

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: MockStdin;
  kill: (sig?: string) => void;
}

let nextMockChildBehaviour: (child: MockChild, args: string[]) => void = () => {};
let behaviourQueue: Array<(child: MockChild, args: string[]) => void> = [];
let lastSpawnArgs: { cmd: string; args: string[]; opts: any } | null = null;
let lastStdin = "";
let spawnCount = 0;

vi.mock("node:child_process", async () => {
  return {
    spawn: (cmd: string, args: string[], opts: any) => {
      spawnCount += 1;
      lastSpawnArgs = { cmd, args, opts };
      const child = new EventEmitter() as MockChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const stdin = new EventEmitter() as MockStdin;
      stdin.end = (chunk?: string) => {
        if (typeof chunk === "string") lastStdin += chunk;
      };
      stdin.write = (chunk: string) => {
        lastStdin += chunk;
        return true;
      };
      child.stdin = stdin;
      child.kill = () => {};
      // Defer behaviour to microtask so the caller gets a chance to wire
      // listeners before we emit.
      const behaviour = behaviourQueue.shift() ?? nextMockChildBehaviour;
      queueMicrotask(() => behaviour(child, args));
      return child;
    },
  };
});

const { createCliProvider, CLI_TIMEOUT_JOIN_MS } = await import("../../src/intelligence/cli.js");
const {
  STAGE1_STDIN_CEILING,
  EXTRACT_EVIDENCE_SLICE,
  EXTRACT_REREAD_WINDOW,
} = await import("../../src/intelligence/extract-prompt.js");
const { DEFAULT_CONFIG } = await import("../../src/types/config.js");

beforeEach(() => {
  lastSpawnArgs = null;
  lastStdin = "";
  spawnCount = 0;
  behaviourQueue = [];
  nextMockChildBehaviour = () => {};
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function respondWith(envelope: Record<string, unknown>) {
  return (child: MockChild) => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(envelope)));
    child.emit("close", 0);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCliProvider — extractFactsFromEvents", () => {
  /**
   * A stub fallback whose output is unmistakable.
   *
   * These tests used to prove the CLI provider had fallen back by checking that
   * the heuristic's regexes matched "I'm allergic to aspirin". The heuristic no
   * longer carries rules — that was a personal ontology hardcoded into a general
   * engine — so it extracts nothing, and "fell back" became indistinguishable
   * from "did nothing at all".
   *
   * Stubbing the fallback tests what these tests are actually for: that a failing
   * subprocess delegates. What it delegates *to* is not their business.
   */
  const FALLBACK_MARKER = "__from_fallback__";
  const stubFallback = {
    async classifyFacts() { return []; },
    async extractEntities() { return new Map(); },
    async extractFactsFromEvents() {
      // A fallback provider reports its own work as un-degraded. Whether the
      // *configured* extractor ran is the caller's judgement, not the
      // fallback's — the CLI provider sets degraded when it delegates here.
      return {
        facts: [
          {
            content: FALLBACK_MARKER,
            domain_hint: null,
            source_quality: "heuristic" as const,
          },
        ],
        degraded: false,
      };
    },
    async detectSupersession() { return null; },
    async reconcile() { return { kind: "add" as const }; },
    async summarise() { return { summary: "", openThreads: [] }; },
  };

  it("parses structured_output and returns typed ExtractedFact[]", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "ok",
      structured_output: {
        facts: [
          {
            content: "Allergic to aspirin",
            domain: "medical",
            subdomain: null,
            confidence: 0.9,
            importance: 0.95,
            capture_context: "discussing medication",
            valid_from: null,
            valid_until: null,
            entities: [{ name: "aspirin", type: "substance", relationship: "allergic_to" }],
          },
        ],
      },
    });

    const provider = createCliProvider();
    const events = [
      { id: "e1", role: "user", content: "I'm allergic to aspirin", sequence: 1 } as any,
    ];
    const result = await provider.extractFactsFromEvents(events, []);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe("Allergic to aspirin");
    expect(result.facts[0].domain_hint).toBe("medical");
    expect(result.facts[0].confidence_signal).toBe(0.9);
    expect(result.facts[0].source_quality).toBe("cli");
    expect(result.facts[0].entities?.[0]?.name).toBe("aspirin");
    expect(result.facts[0].valid_from).toBeNull();
    // The extractor ran, so the caller may advance its watermark.
    expect(result.degraded).toBe(false);
  });

  it("accepts an ISO valid_from and drops a hedge", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "ok",
      structured_output: {
        facts: [
          {
            content: "Went to the beach on 25 August 2026",
            domain: "profile",
            valid_from: "2026-08-25",
            valid_until: null,
            entities: [],
          },
          {
            content: "Worked in a bar when younger",
            domain: "work",
            valid_from: "about five years ago",
            valid_until: null,
            entities: [],
          },
        ],
      },
    });
    const provider = createCliProvider();
    const result = await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "beach", sequence: 1 } as any],
      [],
    );
    expect(result.facts[0].valid_from).toBe("2026-08-25T00:00:00.000Z");
    expect(result.facts[1].valid_from).toBeNull();
  });

  it("spawns with --setting-sources user and OPENMEMORY_SUBPROCESS=1", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "",
      structured_output: { facts: [] },
    });
    const provider = createCliProvider();
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "test", sequence: 1 } as any],
      [],
    );
    expect(lastSpawnArgs?.args).toContain("--setting-sources");
    const idx = lastSpawnArgs!.args.indexOf("--setting-sources");
    expect(lastSpawnArgs!.args[idx + 1]).toBe("user");
    expect(lastSpawnArgs!.opts?.env?.OPENMEMORY_SUBPROCESS).toBe("1");
    // Prompt is stdin, not argv — the last argv element is the model, not the payload.
    expect(lastSpawnArgs!.args.at(-1)).toBe("haiku");
    expect(lastSpawnArgs!.args).not.toContain(lastStdin);
  });

  it("threads working memory, session summary and long-term memory into the stage-1 payload", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "",
      structured_output: { facts: [] },
    });
    const provider = createCliProvider();
    await provider.extractFactsFromEvents(
      [{ id: "e2", role: "user", content: "and I moved to Porto", sequence: 2 } as any],
      [{ id: "e1", role: "user", content: "we were talking about my move", sequence: 1 } as any],
      "The user has been discussing relocating for work.",
      [{ id: "f1", content: "User lives in Lisbon", domain: "profile" } as any],
    );
    expect(lastStdin).toContain("candidate_events");
    expect(lastStdin).toContain("and I moved to Porto");
    expect(lastStdin).toContain("recent_events");
    expect(lastStdin).toContain("we were talking about my move");
    expect(lastStdin).toContain("session_summary");
    expect(lastStdin).toContain("relocating for work");
    expect(lastStdin).toContain("long_term_memory");
    expect(lastStdin).toContain("User lives in Lisbon");
  });

  it("keeps a truncated stage-1 payload under the stdin ceiling", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "",
      structured_output: { facts: [] },
    });
    const max = DEFAULT_CONFIG.extraction.max_content_length;
    const fill = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${tag}-${i}`,
        role: "user",
        content: "x".repeat(max),
        sequence: i + 1,
      })) as any[];
    const provider = createCliProvider();
    await provider.extractFactsFromEvents(
      fill(DEFAULT_CONFIG.extraction.batch_size, "c"),
      fill(EXTRACT_EVIDENCE_SLICE, "e"),
      null,
      [],
      { reminderEvents: fill(EXTRACT_REREAD_WINDOW, "r") },
    );
    expect(lastStdin.length).toBeLessThan(STAGE1_STDIN_CEILING);
    const marker = "\nINPUT:\n";
    const idx = lastStdin.indexOf(marker);
    expect(idx).toBeGreaterThanOrEqual(0);
    const payload = JSON.parse(lastStdin.slice(idx + marker.length)) as {
      candidate_events: Array<{ content: string }>;
      recent_events: Array<{ content: string }>;
      reminder_events: Array<{ content: string }>;
    };
    for (const ev of [
      ...payload.candidate_events,
      ...payload.recent_events,
      ...payload.reminder_events,
    ]) {
      expect(ev.content.length).toBeLessThanOrEqual(max);
    }
  });

  it("keeps argv under the Windows command-line limit when the prompt is huge", async () => {
    // Windows CreateProcess caps the full command line at 32,767 characters.
    // A pulled transcript event of tens of kilobytes used to go on argv and
    // every extract on Windows degraded with ENAMETOOLONG.
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "",
      structured_output: { facts: [] },
    });
    const huge = "x".repeat(40_000);
    const provider = createCliProvider();
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: huge, sequence: 1 } as any],
      [],
    );
    expect(lastStdin).toContain(huge);
    expect(lastSpawnArgs!.args.some((a) => a.includes(huge))).toBe(false);
    const argvChars = lastSpawnArgs!.args.reduce((n, a) => n + a.length + 3, 0);
    expect(argvChars).toBeLessThan(32_767);
  });

  it("falls back to heuristic when spawn emits error", async () => {
    nextMockChildBehaviour = (child) => {
      child.emit("error", new Error("ENOENT"));
    };
    const provider = createCliProvider({}, stubFallback);
    const result = await provider.extractFactsFromEvents(
      [
        {
          id: "e1",
          role: "user",
          content: "I'm allergic to aspirin",
          sequence: 1,
        } as any,
      ],
      [],
    );
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    expect(result.facts[0].source_quality).toBe("heuristic");
    // The point of the flag: these events were never examined, so the caller
    // must not advance past them.
    expect(result.degraded).toBe(true);
  });

  it("falls back to heuristic when subprocess exits non-zero", async () => {
    nextMockChildBehaviour = (child) => {
      child.stderr.emit("data", Buffer.from("auth failed"));
      child.emit("close", 1);
    };
    const provider = createCliProvider({}, stubFallback);
    const result = await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    expect(result.facts[0].source_quality).toBe("heuristic");
    expect(result.degraded).toBe(true);
  });

  it("falls back to heuristic when envelope has is_error true", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: true,
      result: "rate limit exceeded",
    });
    const provider = createCliProvider({}, stubFallback);
    const result = await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    expect(result.facts[0].source_quality).toBe("heuristic");
    expect(result.degraded).toBe(true);
  });

  it("falls back to heuristic when structured_output is missing", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "sorry I don't speak JSON",
    });
    const provider = createCliProvider({}, stubFallback);
    const result = await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    expect(result.facts[0].source_quality).toBe("heuristic");
    expect(result.degraded).toBe(true);
  });

  it("times out after the configured window", async () => {
    vi.useFakeTimers();
    nextMockChildBehaviour = () => {
      /* never emit */
    };
    const provider = createCliProvider({ timeoutMs: 100 }, stubFallback);
    const eventPromise = provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    // Timeout then join, twice (extract retries once).
    await vi.advanceTimersByTimeAsync(2 * (100 + CLI_TIMEOUT_JOIN_MS));
    vi.useRealTimers();
    const result = await eventPromise;
    expect(result.facts[0].content).toBe(FALLBACK_MARKER);
    expect(result.degraded).toBe(true);
    expect(spawnCount).toBe(2);
  });

  it("always logs non-zero-exit with exit code when debug is off", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    nextMockChildBehaviour = (child) => child.emit("close", 1);
    const provider = createCliProvider({ debug: false }, stubFallback);
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    const lines = err.mock.calls.map((c) => c.map(String).join(" "));
    err.mockRestore();
    const failureLines = lines.filter((l) => l.includes("stage-1-extract") && l.includes("non-zero-exit"));
    expect(failureLines.length).toBeGreaterThanOrEqual(1);
    expect(failureLines[0]).toContain("stage-1-extract failed (non-zero-exit)");
    expect(failureLines[0]).toContain("exit=1");
    expect(failureLines[0]).toContain('stderr=""');
    expect(failureLines[0]).toContain("— retrying once");
  });

  it("logs exit=null when close reports null", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    nextMockChildBehaviour = (child) => child.emit("close", null);
    const provider = createCliProvider({ debug: false }, stubFallback);
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    const lines = err.mock.calls.map((c) => c.map(String).join(" "));
    err.mockRestore();
    const failureLines = lines.filter((l) => l.includes("non-zero-exit"));
    expect(failureLines[0]).toContain("exit=null");
  });

  it("always logs timeout failures when debug is off", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    nextMockChildBehaviour = () => {
      /* never emit */
    };
    const provider = createCliProvider({ timeoutMs: 100, debug: false }, stubFallback);
    const eventPromise = provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    await vi.advanceTimersByTimeAsync(2 * (100 + CLI_TIMEOUT_JOIN_MS));
    vi.useRealTimers();
    await eventPromise;
    const lines = err.mock.calls.map((c) => c.map(String).join(" "));
    err.mockRestore();
    const failureLines = lines.filter((l) => l.includes("failed (timeout)"));
    expect(failureLines[0]).toContain("stage-1-extract failed (timeout)");
    expect(failureLines[0]).toContain("after=100ms");
    expect(failureLines[0]).toContain("— retrying once");
  });

  it("logs extract success only when debug is on", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "",
      structured_output: { facts: [] },
    });
    const provider = createCliProvider({ debug: true });
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "test", sequence: 1 } as any],
      [],
    );
    const lines = err.mock.calls.map((c) => c.map(String).join(" "));
    err.mockRestore();
    expect(lines.some((l) => l.includes("stage-1-extract ok in"))).toBe(true);
  });

  it("does not double-log a failure when debug is on", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    nextMockChildBehaviour = (child) => child.emit("close", 1);
    const provider = createCliProvider({ debug: true }, stubFallback);
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    const lines = err.mock.calls.map((c) => c.map(String).join(" "));
    err.mockRestore();
    const firstAttempt = lines.filter((l) => l.includes("stage-1-extract failed (non-zero-exit)"));
    expect(firstAttempt).toHaveLength(1);
    expect(lines.filter((l) => l.includes("ok in"))).toHaveLength(0);
  });

  it("retries extract once on non-zero-exit and keeps CLI facts", async () => {
    behaviourQueue = [
      (child) => child.emit("close", 1),
      respondWith({
        is_error: false,
        result: "ok",
        structured_output: {
          facts: [
            {
              content: "Allergic to aspirin",
              domain: "medical",
              entities: [],
            },
          ],
        },
      }),
    ];
    const provider = createCliProvider({}, stubFallback);
    const result = await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I'm allergic to aspirin", sequence: 1 } as any],
      [],
    );
    expect(result.degraded).toBe(false);
    expect(spawnCount).toBe(2);
    expect(result.facts[0].content).toBe("Allergic to aspirin");
    expect(result.facts[0].source_quality).toBe("cli");
  });

  it("retries extract timeout once then degrades after two hangs", async () => {
    vi.useFakeTimers();
    nextMockChildBehaviour = () => {
      /* never emit */
    };
    const provider = createCliProvider({ timeoutMs: 100 }, stubFallback);
    const eventPromise = provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    await vi.advanceTimersByTimeAsync(2 * (100 + CLI_TIMEOUT_JOIN_MS));
    vi.useRealTimers();
    const result = await eventPromise;
    expect(result.degraded).toBe(true);
    expect(spawnCount).toBe(2);
  });

  it("does not retry spawn-error", async () => {
    nextMockChildBehaviour = (child) => {
      child.emit("error", new Error("ENOENT"));
    };
    const provider = createCliProvider({}, stubFallback);
    const result = await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I'm allergic to aspirin", sequence: 1 } as any],
      [],
    );
    expect(result.degraded).toBe(true);
    expect(spawnCount).toBe(1);
  });

  it("does not retry is-error envelopes", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: true,
      result: "rate limit exceeded",
    });
    const provider = createCliProvider({}, stubFallback);
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    expect(spawnCount).toBe(1);
  });

  it("does not retry parse-error or missing structured_output", async () => {
    nextMockChildBehaviour = (child) => {
      child.stdout.emit("data", Buffer.from("not-json"));
      child.emit("close", 0);
    };
    const provider = createCliProvider({}, stubFallback);
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    expect(spawnCount).toBe(1);

    spawnCount = 0;
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "sorry I don't speak JSON",
    });
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "I prefer dark roast", sequence: 1 } as any],
      [],
    );
    expect(spawnCount).toBe(1);
  });
});

describe("createCliProvider — reconcile", () => {
  it("returns {kind:'add'} when no existing facts", async () => {
    const provider = createCliProvider();
    const decision = await provider.reconcile(
      { id: "s1", content: "new fact" } as any,
      [],
    );
    expect(decision.kind).toBe("add");
  });

  it("returns noop when LLM emits noop decision", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      structured_output: { decisions: [{ id: "s1", decision: "noop" }] },
    });
    const provider = createCliProvider();
    const decision = await provider.reconcile(
      { id: "s1", content: "existing paraphrase" } as any,
      [{ id: "f1", content: "existing fact" } as any],
    );
    expect(decision.kind).toBe("noop");
  });

  it("returns enrich with existingFactId validated against candidates", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      structured_output: {
        decisions: [{ id: "s1", decision: "enrich", existingFactId: "f1" }],
      },
    });
    const provider = createCliProvider();
    const decision = await provider.reconcile(
      { id: "s1", content: "paraphrase" } as any,
      [{ id: "f1", content: "existing" } as any],
    );
    expect(decision.kind).toBe("enrich");
    if (decision.kind === "enrich") {
      expect(decision.existingFactId).toBe("f1");
    }
  });

  it("treats hallucinated existingFactId as 'add'", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      structured_output: {
        decisions: [{ id: "s1", decision: "enrich", existingFactId: "nonsense" }],
      },
    });
    const provider = createCliProvider();
    const decision = await provider.reconcile(
      { id: "s1", content: "x" } as any,
      [{ id: "f1", content: "y" } as any],
    );
    expect(decision.kind).toBe("add");
  });

  it("logs reconcile non-zero-exit always-on and does not retry", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    nextMockChildBehaviour = (child) => child.emit("close", 1);
    const provider = createCliProvider({ debug: false });
    const decision = await provider.reconcile(
      { id: "s1", content: "x" } as any,
      [{ id: "f1", content: "y" } as any],
    );
    const lines = err.mock.calls.map((c) => c.map(String).join(" "));
    err.mockRestore();
    expect(decision.kind).toBe("add");
    expect(spawnCount).toBe(1);
    const failureLines = lines.filter((l) => l.includes("stage-2-reconcile"));
    expect(failureLines).toHaveLength(1);
    expect(failureLines[0]).toContain("stage-2-reconcile failed (non-zero-exit)");
    expect(failureLines[0]).toContain("exit=1");
    expect(failureLines[0]).not.toContain("— retrying once");
  });
});

describe("createCliProvider — detectSupersession", () => {
  it("returns null when no same-domain active candidates", async () => {
    const provider = createCliProvider();
    const result = await provider.detectSupersession(
      { id: "s1", content: "new", domain: "profile" } as any,
      [],
    );
    expect(result).toBeNull();
  });

  it("returns supersession candidate when LLM identifies one", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      structured_output: {
        supersessions: [{ new_id: "s1", existing_id: "f1", reason: "location change" }],
      },
    });
    const provider = createCliProvider();
    const result = await provider.detectSupersession(
      { id: "s1", content: "moved to Porto", domain: "profile" } as any,
      [
        {
          id: "f1",
          content: "live in Lisbon",
          domain: "profile",
          status: "active",
          is_latest: true,
        } as any,
      ],
    );
    expect(result?.existingFactId).toBe("f1");
  });
});

describe("createCliProvider — summarise", () => {
  it("returns LLM summary + openThreads", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      structured_output: {
        summary: "User captured medical and preferences facts.",
        openThreads: ["follow up on allergy severity"],
      },
    });
    const provider = createCliProvider();
    const result = await provider.summarise(
      [],
      [{ id: "f1", content: "x", domain: "medical", subdomain: null } as any],
    );
    expect(result.summary).toContain("medical");
    expect(result.openThreads).toHaveLength(1);
  });

  it("returns heuristic summary for empty integration set", async () => {
    const provider = createCliProvider();
    const result = await provider.summarise([], []);
    expect(result.summary).toBe("No facts integrated.");
  });

  it("threads the prior rolling summary into the stage-4 payload", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      structured_output: { summary: "cumulative", openThreads: [] },
    });
    const provider = createCliProvider();
    await provider.summarise(
      [],
      [{ id: "f1", content: "x", domain: "medical", subdomain: null } as any],
      "Earlier the user shared work context.",
    );
    expect(lastStdin).toContain("prior_summary");
    expect(lastStdin).toContain("Earlier the user shared work context.");
  });
});

describe("createCliProvider — explicit captures get real intelligence", () => {
  /**
   * Facts inferred from events are classified and have their entities extracted
   * during stage 1, so consolidation never asks the provider about them. What
   * reaches classifyFacts and extractEntities is the explicit capture path —
   * capture_fact — which is the path every tool description tells an assistant
   * to use.
   *
   * Both used to delegate straight to the heuristic. That was defensible while
   * the heuristic carried a keyword vocabulary and a name regex; once the engine
   * stopped shipping either, the delegation quietly became "route everything to
   * the fallback domain and extract nothing". Measured on one sentence: as an
   * event it produced a real domain and three typed entities; through
   * capture_fact, the default domain and none.
   */
  const stubFallback = {
    async classifyFacts(facts: any[]) {
      return facts.map((f) => ({
        id: f.id,
        content: f.content,
        domain: "__fallback__",
        subdomain: null,
      }));
    },
    async extractEntities() {
      return new Map([["__fallback__", []]]);
    },
    async extractFactsFromEvents() { return { facts: [], degraded: false }; },
    async detectSupersession() { return null; },
    async reconcile() { return { kind: "add" as const }; },
    async summarise() { return { summary: "", openThreads: [] }; },
  };

  const facts = [
    { id: "f1", content: "Robin at Acme leads the Atlas migration" },
    { id: "f2", content: "The user is allergic to shellfish" },
  ] as any[];

  it("routes explicit facts with the model rather than the fallback", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "",
      structured_output: {
        classifications: [
          { id: "f1", domain: "work", subdomain: "leadership" },
          { id: "f2", domain: "health", subdomain: null },
        ],
      },
    });

    const provider = createCliProvider({}, stubFallback as any);
    const classified = await provider.classifyFacts(facts);

    expect(classified.map((c) => c.domain)).toEqual(["work", "health"]);
    expect(classified[0].subdomain).toBe("leadership");
    // Not a single one came from the fallback.
    expect(classified.some((c) => c.domain === "__fallback__")).toBe(false);
  });

  it("classifies a fact the model omitted rather than dropping it", async () => {
    // A fact that comes back unclassified would be dropped by consolidation.
    // Anything the model skips has to fall through, not vanish.
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "",
      structured_output: {
        classifications: [{ id: "f1", domain: "work", subdomain: null }],
      },
    });

    const provider = createCliProvider({}, stubFallback as any);
    const classified = await provider.classifyFacts(facts);

    expect(classified).toHaveLength(2);
    expect(classified.find((c) => c.id === "f1")!.domain).toBe("work");
    expect(classified.find((c) => c.id === "f2")!.domain).toBe("__fallback__");
  });

  it("falls back for every fact when the classify stage fails", async () => {
    nextMockChildBehaviour = (child) => child.emit("close", 1);

    const provider = createCliProvider({}, stubFallback as any);
    const classified = await provider.classifyFacts(facts);

    expect(classified).toHaveLength(2);
    expect(classified.every((c) => c.domain === "__fallback__")).toBe(true);
  });

  it("extracts entities for explicit facts, marking the subject", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "",
      structured_output: {
        facts: [
          {
            id: "f1",
            entities: [
              { name: "Robin", type: "person", relationship: "subject_of" },
              { name: "Acme", type: "organisation", relationship: "employer" },
            ],
          },
          { id: "f2", entities: [] },
        ],
      },
    });

    const provider = createCliProvider({}, stubFallback as any);
    const map = await provider.extractEntities(facts);

    expect(map.get("f1")!.map((e) => e.name)).toEqual(["Robin", "Acme"]);
    expect(map.get("f1")![0].relationship).toBe("subject_of");
    // A fact naming nothing is absent rather than mapped to an empty list.
    expect(map.has("f2")).toBe(false);
    expect(map.has("__fallback__")).toBe(false);
  });

  it("falls back when the entity stage fails", async () => {
    nextMockChildBehaviour = (child) => child.emit("close", 1);

    const provider = createCliProvider({}, stubFallback as any);
    const map = await provider.extractEntities(facts);

    expect(map.has("__fallback__")).toBe(true);
  });

  it("spawns nothing when there is nothing to classify or extract", async () => {
    const provider = createCliProvider({}, stubFallback as any);

    expect(await provider.classifyFacts([])).toEqual([]);
    expect((await provider.extractEntities([])).size).toBe(0);
    expect(lastSpawnArgs).toBeNull();
  });
});

describe("createCliProvider — billed usage", () => {
  const stubFallback = {
    async classifyFacts() { return []; },
    async extractEntities() { return new Map(); },
    async extractFactsFromEvents() {
      return { facts: [], degraded: false };
    },
    async detectSupersession() { return null; },
    async reconcile() { return { kind: "add" as const }; },
    async summarise() { return { summary: "", openThreads: [] }; },
  };

  it("records provider, model, and tokens from the envelope", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "ok",
      usage: { input_tokens: 120, output_tokens: 15, total_cost_usd: 0.01 },
      structured_output: { facts: [] },
    });
    const provider = createCliProvider({ model: "haiku" });
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "The user prefers oat milk", sequence: 1 } as any],
      [],
    );
    const usage = provider.takeUsage?.();
    expect(usage).toBeTruthy();
    expect(usage!.calls).toBe(1);
    expect(usage!.input_tokens).toBe(120);
    expect(usage!.output_tokens).toBe(15);
    expect(usage).not.toHaveProperty("total_cost_usd");
    expect(usage!.stages.extract.provider).toBe("cli");
    expect(usage!.stages.extract.model).toBe("haiku");
  });

  it("omits token keys when the envelope has no usage", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "ok",
      structured_output: { facts: [] },
    });
    const provider = createCliProvider();
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "The user prefers oat milk", sequence: 1 } as any],
      [],
    );
    const usage = provider.takeUsage?.();
    expect(usage!.calls).toBe(1);
    expect(usage).not.toHaveProperty("input_tokens");
    expect(usage!.stages.extract).not.toHaveProperty("input_tokens");
  });

  it("counts a retried extract as two calls", async () => {
    behaviourQueue.push((child) => child.emit("close", 1));
    behaviourQueue.push(
      respondWith({
        is_error: false,
        result: "ok",
        usage: { input_tokens: 10, output_tokens: 2 },
        structured_output: { facts: [] },
      }),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = createCliProvider({}, stubFallback);
    await provider.extractFactsFromEvents(
      [{ id: "e1", role: "user", content: "The user prefers oat milk", sequence: 1 } as any],
      [],
    );
    err.mockRestore();
    const usage = provider.takeUsage?.();
    expect(usage!.stages.extract.calls).toBe(2);
    expect(usage!.input_tokens).toBe(10);
  });

  it("counts two extract calls plus a retry as three", async () => {
    behaviourQueue.push((child) => child.emit("close", 1));
    behaviourQueue.push(
      respondWith({
        is_error: false,
        result: "ok",
        usage: { input_tokens: 10, output_tokens: 1 },
        structured_output: { facts: [] },
      }),
    );
    behaviourQueue.push(
      respondWith({
        is_error: false,
        result: "ok",
        usage: { input_tokens: 20, output_tokens: 2 },
        structured_output: { facts: [] },
      }),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = createCliProvider({}, stubFallback);
    const event = { id: "e1", role: "user", content: "The user prefers oat milk", sequence: 1 } as any;
    await provider.extractFactsFromEvents([event], []);
    await provider.extractFactsFromEvents([{ ...event, id: "e2", sequence: 2 }], []);
    err.mockRestore();
    const usage = provider.takeUsage?.();
    expect(usage!.stages.extract.calls).toBe(3);
    expect(usage!.input_tokens).toBe(30);
  });

  it("records classify as its own stage with identity", async () => {
    nextMockChildBehaviour = respondWith({
      is_error: false,
      result: "",
      usage: { input_tokens: 40, output_tokens: 6 },
      structured_output: {
        classifications: [{ id: "f1", domain: "preferences", subdomain: null }],
      },
    });
    const provider = createCliProvider({ model: "haiku" }, stubFallback as any);
    await provider.classifyFacts([
      { id: "f1", content: "The user prefers oat milk" } as any,
    ]);
    const usage = provider.takeUsage?.();
    expect(usage!.stages.classify).toMatchObject({
      provider: "cli",
      model: "haiku",
      calls: 1,
      input_tokens: 40,
      output_tokens: 6,
    });
    expect(usage!.stages).not.toHaveProperty("extract");
  });
});
