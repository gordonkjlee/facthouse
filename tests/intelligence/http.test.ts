import { describe, it, expect } from "vitest";
import {
  createHttpProvider,
  formatHttpModelHint,
  httpChatJson,
  httpExtractFailHint,
  httpModelOf,
  parseHttpUsage,
  partitionHttpModels,
  probeHttpModels,
  resolveHttpChatTarget,
  type HttpFetcher,
} from "../../src/intelligence/http.js";
import {
  createIntelligenceProvider,
  PROVIDER_ENV_VAR,
} from "../../src/intelligence/provider.js";
import {
  createStageRouter,
  httpIsConfigured,
  resolveStageOnFail,
  resolveStageProviderType,
  usesStageRouter,
} from "../../src/intelligence/stage-router.js";
import { createHeuristicProvider } from "../../src/intelligence/heuristic.js";
import type { IntelligenceConfig } from "../../src/types/config.js";
import type { SessionEvent } from "../../src/types/data.js";

const base: IntelligenceConfig = { provider: "cli", api_key: null };

function event(content: string): SessionEvent {
  return {
    id: "e1",
    mcp_session_id: "s",
    client_session_id: "s",
    sequence: 1,
    event_type: "message",
    role: "user",
    content_type: "text",
    content,
    content_ref: null,
    occurred_at: null,
    speaker: null,
    metadata: null,
    created_at: "2026-08-31T12:00:00.000Z",
  };
}

function jsonFetcher(payload: unknown): HttpFetcher {
  return async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: JSON.stringify(payload) } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      });
    },
  });
}

describe("http discovery", () => {
  it("keeps embed-only names out of the chat list", () => {
    expect(
      partitionHttpModels(["qwen2.5vl:7b", "nomic-embed-text:latest"]),
    ).toEqual({
      chat: ["qwen2.5vl:7b"],
      embed: ["nomic-embed-text:latest"],
    });
  });

  it("reads OpenAI-style /models ids", async () => {
    const listed = await probeHttpModels("http://localhost:1234/v1", async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ data: [{ id: "local-chat" }] });
      },
    }));
    expect(listed).toEqual({
      ok: true,
      baseUrl: "http://localhost:1234/v1",
      ids: ["local-chat"],
    });
  });

  it("names typical OpenAI-compat roots when the host is down", () => {
    expect(httpExtractFailHint("http://localhost:11434/v1")).toMatch(/1234\/v1/);
    expect(httpExtractFailHint("http://localhost:11434/v1")).toMatch(/8000\/v1/);
    expect(httpExtractFailHint("http://localhost:11434/v1")).toMatch(/8080\/v1/);
  });

  it("asks the user to pin when several chat models exist", () => {
    expect(
      formatHttpModelHint({
        baseUrl: "http://localhost:11434/v1",
        chat: ["qwen2.5vl:7b", "qwen2.5:1.5b"],
        embed: ["nomic-embed-text:latest"],
      }),
    ).toMatch(/Set intelligence\.http\.model/);
  });

  it("treats a unique chat model as resolved", async () => {
    const found = await resolveHttpChatTarget({
      preferredBaseUrl: "http://localhost:11434/v1",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: [{ id: "qwen2.5vl:7b" }, { id: "nomic-embed-text:latest" }],
          });
        },
      }),
    });
    expect(found.ok).toBe(true);
    expect(found.model).toBe("qwen2.5vl:7b");
  });
});

describe("http config", () => {
  it("treats a missing or blank model as unconfigured", () => {
    expect(httpModelOf(undefined)).toBeNull();
    expect(httpModelOf({})).toBeNull();
    expect(httpModelOf({ model: "  " })).toBeNull();
    expect(httpIsConfigured(base)).toBe(false);
    expect(httpIsConfigured({ ...base, http: { model: "qwen2.5:7b" } })).toBe(
      true,
    );
  });

  it("maps OpenAI-style usage tokens", () => {
    expect(
      parseHttpUsage({ usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    ).toEqual({ input_tokens: 3, output_tokens: 2 });
  });
});

describe("engine-default stage routing", () => {
  const httpOn: IntelligenceConfig = {
    ...base,
    http: { model: "qwen2.5:7b" },
  };

  it("sends extract and summarise to http, contradiction to cli", () => {
    expect(resolveStageProviderType(httpOn, "extract")).toBe("http");
    expect(resolveStageProviderType(httpOn, "summarise")).toBe("http");
    expect(resolveStageProviderType(httpOn, "reconcile")).toBe("cli");
    expect(resolveStageProviderType(httpOn, "supersede")).toBe("cli");
    expect(resolveStageOnFail(httpOn, "extract")).toBe("cli");
    expect(resolveStageOnFail(httpOn, "summarise")).toBe("cli");
    expect(resolveStageOnFail(httpOn, "reconcile")).toBe("none");
    expect(resolveStageOnFail(httpOn, "supersede")).toBe("none");
  });

  it("lets an explicit stages map win", () => {
    const cfg: IntelligenceConfig = {
      ...httpOn,
      stages: {
        extract: { provider: "cli" },
        reconcile: { provider: "http" },
      },
    };
    expect(resolveStageProviderType(cfg, "extract")).toBe("cli");
    expect(resolveStageProviderType(cfg, "reconcile")).toBe("http");
    expect(resolveStageProviderType(cfg, "supersede")).toBe("cli");
  });

  it("routes when the CLI graduate model differs with no HTTP", () => {
    const split: IntelligenceConfig = {
      ...base,
      cli: { model: "haiku", graduate_model: "sonnet" },
    };
    expect(usesStageRouter(split)).toBe(true);
    expect(usesStageRouter({ ...base, cli: { model: "haiku" } })).toBe(false);
  });

  it("does not mix HTTP routing under a heuristic kill-switch", () => {
    expect(
      usesStageRouter(httpOn, { [PROVIDER_ENV_VAR]: "heuristic" }),
    ).toBe(false);
    expect(
      resolveStageProviderType(httpOn, "extract", {
        [PROVIDER_ENV_VAR]: "heuristic",
      }),
    ).toBe("heuristic");
  });
});

describe("HTTP extract", () => {
  it("records source_quality http and usage on a valid JSON body", async () => {
    const provider = createHttpProvider({
      model: "qwen2.5:7b",
      fetch: jsonFetcher({
        facts: [
          {
            content: "Alex keeps a brass kaleidoscope on the desk at Acme.",
            domain: "work",
            entities: [
              { name: "Alex", type: "person", relationship: "subject_of" },
            ],
          },
        ],
      }),
    });
    const out = await provider.extractFactsFromEvents(
      [event("Alex keeps a brass kaleidoscope on the desk at Acme.")],
      [],
    );
    expect(out.degraded).toBe(false);
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0].source_quality).toBe("http");
    expect(out.facts[0].content).toMatch(/kaleidoscope/);
    const usage = provider.takeUsage?.();
    expect(usage?.stages.extract.provider).toBe("http");
    expect(usage?.stages.extract.model).toBe("qwen2.5:7b");
    expect(usage?.input_tokens).toBe(10);
    expect(usage?.output_tokens).toBe(4);
  });

  it("returns degraded empty facts when the host is down — no heuristic extract", async () => {
    const provider = createHttpProvider({
      model: "qwen2.5:7b",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const out = await provider.extractFactsFromEvents(
      [event("Alex prefers tea.")],
      [],
    );
    expect(out.degraded).toBe(true);
    expect(out.facts).toEqual([]);
  });
});

describe("createIntelligenceProvider with HTTP", () => {
  it("routes extract to the fake HTTP client when http.model is set", async () => {
    const provider = createIntelligenceProvider(
      { ...base, http: { model: "qwen2.5:7b" } },
      {
        fetch: jsonFetcher({
          facts: [
            {
              content: "The user prefers tea.",
              domain: "preferences",
              entities: [],
            },
          ],
        }),
      },
    );
    const out = await provider.extractFactsFromEvents(
      [event("The user prefers tea.")],
      [],
    );
    expect(out.facts[0].source_quality).toBe("http");
  });

  it("does not treat provider http without a model as configured extract", async () => {
    const provider = createIntelligenceProvider(
      { ...base, provider: "http" },
      {
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    );
    const out = await provider.extractFactsFromEvents(
      [event("The user prefers tea.")],
      [],
    );
    expect(out.degraded).toBe(true);
    expect(out.facts).toEqual([]);
  });

  it("uses the only chat model a live host lists", async () => {
    const provider = createIntelligenceProvider(
      { ...base, provider: "http" },
      {
        fetch: async (url, init) => {
          if (init.method === "GET") {
            return {
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify({
                  data: [
                    { id: "qwen2.5vl:7b" },
                    { id: "nomic-embed-text:latest" },
                  ],
                });
              },
            };
          }
          return jsonFetcher({
            facts: [
              { content: "The user prefers tea.", domain: "preferences" },
            ],
          })(url, init);
        },
      },
    );
    const out = await provider.extractFactsFromEvents(
      [event("The user prefers tea.")],
      [],
    );
    expect(out.degraded).toBe(false);
    expect(out.facts[0].source_quality).toBe("http");
    expect(provider.takeUsage?.()?.stages.extract.model).toBe("qwen2.5vl:7b");
  });

  it("refuses to guess when the host lists several chat models", async () => {
    const provider = createIntelligenceProvider(
      { ...base, provider: "http" },
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              data: [{ id: "qwen2.5vl:7b" }, { id: "qwen2.5:1.5b" }],
            });
          },
        }),
      },
    );
    const out = await provider.extractFactsFromEvents(
      [event("The user prefers tea.")],
      [],
    );
    expect(out.degraded).toBe(true);
    expect(out.facts).toEqual([]);
  });

  it("honours stages.extract.model on the HTTP request body", async () => {
    let seen = "";
    const provider = createIntelligenceProvider(
      {
        ...base,
        http: { model: "qwen2.5:7b" },
        stages: { extract: { provider: "http", model: "qwen2.5vl:7b" } },
      },
      {
        fetch: async (_url, init) => {
          seen = (JSON.parse(init.body) as { model: string }).model;
          return jsonFetcher({
            facts: [{ content: "The user prefers tea.", domain: "preferences" }],
          })(_url, init);
        },
      },
    );
    await provider.extractFactsFromEvents([event("The user prefers tea.")], []);
    expect(seen).toBe("qwen2.5vl:7b");
  });

  it("retries extract on the CLI when HTTP is down", async () => {
    let cliCalls = 0;
    const cli = {
      ...createHeuristicProvider(),
      async extractFactsFromEvents() {
        cliCalls += 1;
        return {
          facts: [
            {
              content: "Alex keeps a brass kaleidoscope on the desk at Acme.",
              domain_hint: "work",
              source_quality: "cli" as const,
            },
          ],
          degraded: false,
        };
      },
    };
    const provider = createIntelligenceProvider(
      { ...base, http: { model: "qwen2.5:7b" } },
      {
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
        cli,
      },
    );
    const out = await provider.extractFactsFromEvents(
      [event("Alex keeps a brass kaleidoscope on the desk at Acme.")],
      [],
    );
    expect(cliCalls).toBe(1);
    expect(out.degraded).toBe(false);
    expect(out.facts[0].source_quality).toBe("cli");
  });

  it("honours extract on_fail none — no CLI steal when HTTP is down", async () => {
    let cliCalls = 0;
    const cli = {
      ...createHeuristicProvider(),
      async extractFactsFromEvents() {
        cliCalls += 1;
        return { facts: [], degraded: false };
      },
    };
    const provider = createIntelligenceProvider(
      {
        ...base,
        http: { model: "qwen2.5:7b" },
        stages: { extract: { provider: "http", on_fail: "none" } },
      },
      {
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
        cli,
      },
    );
    const out = await provider.extractFactsFromEvents(
      [event("Alex prefers tea.")],
      [],
    );
    expect(cliCalls).toBe(0);
    expect(out.degraded).toBe(true);
    expect(out.facts).toEqual([]);
  });

  it("retries CLI extract on HTTP when on_fail is http", async () => {
    const cli = {
      ...createHeuristicProvider(),
      async extractFactsFromEvents() {
        return { facts: [], degraded: true };
      },
    };
    const provider = createIntelligenceProvider(
      {
        ...base,
        http: { model: "qwen2.5:7b" },
        stages: { extract: { provider: "cli", on_fail: "http" } },
      },
      {
        fetch: jsonFetcher({
          facts: [
            { content: "Alex prefers tea.", domain: "preferences" },
          ],
        }),
        cli,
      },
    );
    const out = await provider.extractFactsFromEvents(
      [event("Alex prefers tea.")],
      [],
    );
    expect(out.degraded).toBe(false);
    expect(out.facts[0].source_quality).toBe("http");
  });

  it("does not call the CLI when HTTP extract succeeds", async () => {
    let cliCalls = 0;
    const cli = {
      ...createHeuristicProvider(),
      async extractFactsFromEvents() {
        cliCalls += 1;
        return { facts: [], degraded: false };
      },
    };
    const provider = createIntelligenceProvider(
      { ...base, http: { model: "qwen2.5:7b" } },
      {
        fetch: jsonFetcher({
          facts: [
            {
              content: "The user prefers tea.",
              domain: "preferences",
            },
          ],
        }),
        cli,
      },
    );
    await provider.extractFactsFromEvents([event("The user prefers tea.")], []);
    expect(cliCalls).toBe(0);
  });

  it("sends reconcile to cli when HTTP is opted in without a stages map", async () => {
    let reconcileCalls = 0;
    const cli = {
      ...createHeuristicProvider(),
      async reconcile() {
        reconcileCalls += 1;
        return { kind: "add" as const };
      },
    };
    const provider = createStageRouter(
      { ...base, http: { model: "qwen2.5:7b" } },
      { fetch: jsonFetcher({ facts: [] }), cli },
    );
    await provider.extractFactsFromEvents([event("Alex prefers tea.")], []);
    await provider.reconcile(
      {
        id: "sf1",
        content: "Alex prefers tea.",
      } as never,
      [{ id: "f1", content: "Alex drinks tea.", domain: "preferences" }] as never,
    );
    expect(reconcileCalls).toBe(1);
  });
});

describe("httpChatJson", () => {
  it("parses the message content as JSON", async () => {
    const result = await httpChatJson({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5:7b",
      prompt: "x",
      timeoutMs: 1000,
      fetchImpl: jsonFetcher({ ok: true }),
    });
    expect(result.json).toEqual({ ok: true });
  });
});
