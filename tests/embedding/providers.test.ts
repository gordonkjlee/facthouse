/**
 * Embedding providers and the selector.
 *
 * Both providers are HTTP clients, so these run against an injected/stubbed
 * transport rather than a network. That is a real limit worth stating: the
 * Ollama provider has additionally been exercised against a live service, and
 * the Voyage provider has not — there was no key available when it was written.
 * What is covered here is the request shape, the ordering and alignment
 * guarantees, and the failure paths. What is not covered for Voyage is whether
 * the live API agrees.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createVoyageProvider } = await import("../../src/embedding/voyage.js");
const { createOllamaProvider } = await import("../../src/embedding/ollama.js");
const { createEmbeddingProvider, resolveEmbeddingProviderType } = await import(
  "../../src/embedding/provider.js"
);

/** A fetch stub that records its calls and replays canned responses. */
function stubFetch(handler: (url: string, init: any) => unknown) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    const payload = handler(String(url), init);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("voyage provider", () => {
  const embeddings = (n: number, dims = 3) =>
    Array.from({ length: n }, (_, i) => ({
      embedding: Array.from({ length: dims }, () => i + 1),
      index: i,
    }));

  it("sends input_type, and sends a different one per side", async () => {
    // The correctness trap: retrieval models are trained asymmetrically and
    // Voyage's docs say not to omit this. Getting it wrong degrades every
    // result and raises nothing, so it is asserted rather than commented.
    const { impl, calls } = stubFetch(() => ({ data: embeddings(1) }));
    const p = createVoyageProvider({ apiKey: "k", fetchImpl: impl });

    await p.embed(["text"], "document");
    await p.embed(["text"], "query");

    expect(calls[0].body.input_type).toBe("document");
    expect(calls[1].body.input_type).toBe("query");
  });

  it("passes the configured dimension through as output_dimension", async () => {
    const { impl, calls } = stubFetch(() => ({ data: embeddings(1, 2) }));
    const p = createVoyageProvider({ apiKey: "k", dimensions: 2, fetchImpl: impl });

    await p.embed(["text"], "document");

    expect(calls[0].body.output_dimension).toBe(2);
  });

  it("omits output_dimension when none is configured", async () => {
    const { impl, calls } = stubFetch(() => ({ data: embeddings(1) }));
    const p = createVoyageProvider({ apiKey: "k", fetchImpl: impl });

    await p.embed(["text"], "document");

    expect(calls[0].body).not.toHaveProperty("output_dimension");
  });

  it("orders vectors by the API's index, not array order", async () => {
    // If the API ever returns out of order, trusting array position would
    // attach every fact to a different fact's meaning — wrong in a way nothing
    // downstream could detect.
    const { impl } = stubFetch(() => ({
      data: [
        { embedding: [3, 3, 3], index: 2 },
        { embedding: [1, 1, 1], index: 0 },
        { embedding: [2, 2, 2], index: 1 },
      ],
    }));
    const p = createVoyageProvider({ apiKey: "k", fetchImpl: impl });

    const r = await p.embed(["a", "b", "c"], "document");

    expect(r.vectors.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it("throws when the batch comes back short", async () => {
    // A short batch would misalign vectors with facts from that point on.
    const { impl } = stubFetch(() => ({ data: embeddings(2) }));
    const p = createVoyageProvider({ apiKey: "k", fetchImpl: impl });

    await expect(p.embed(["a", "b", "c"], "document")).rejects.toThrow(
      /2 embeddings for 3 inputs/,
    );
  });

  it("throws on a non-2xx response rather than returning empty", async () => {
    const impl = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      }) as unknown as Response) as unknown as typeof fetch;
    const p = createVoyageProvider({ apiKey: "bad", fetchImpl: impl });

    await expect(p.embed(["a"], "document")).rejects.toThrow(/401/);
  });

  it("spawns no request for an empty batch", async () => {
    const { impl, calls } = stubFetch(() => ({ data: [] }));
    const p = createVoyageProvider({ apiKey: "k", fetchImpl: impl });

    expect((await p.embed([], "document")).vectors).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("ollama provider", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockOllama(vectors: number[][]) {
    const calls: Array<{ input: string[] }> = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: vectors }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it("applies nomic task prefixes, differently per side", async () => {
    // Same asymmetry as Voyage, expressed as a prefix instead of a parameter —
    // which is the point: it is a property of retrieval models, not a vendor
    // quirk. Verified against the live service as well as here.
    const calls = mockOllama([[1, 0]]);
    const p = createOllamaProvider({ model: "nomic-embed-text" });

    await p.embed(["shellfish"], "document");
    await p.embed(["food"], "query");

    expect(calls[0].input).toEqual(["search_document: shellfish"]);
    expect(calls[1].input).toEqual(["search_query: food"]);
  });

  it("does not prefix a model that was not trained on prefixes", async () => {
    // Prefixing blindly makes results worse on such a model, so the behaviour
    // is keyed on the model name rather than applied to everything.
    const calls = mockOllama([[1, 0]]);
    const p = createOllamaProvider({ model: "some-other-model" });

    await p.embed(["shellfish"], "document");

    expect(calls[0].input).toEqual(["shellfish"]);
  });

  it("truncates and renormalises to the configured dimension", async () => {
    // Renormalising is what makes truncation safe: a prefix of a unit vector
    // is not a unit vector, and cosine over unnormalised prefixes would compare
    // magnitudes as well as directions.
    mockOllama([[3, 4, 99, 99]]);
    const p = createOllamaProvider({ dimensions: 2 });

    const r = await p.embed(["x"], "document");

    expect(r.vectors[0].length).toBe(2);
    expect(r.dimensions).toBe(2);
    const norm = Math.hypot(r.vectors[0][0], r.vectors[0][1]);
    expect(norm).toBeCloseTo(1, 6);
    // Direction preserved: 3/5, 4/5.
    expect(r.vectors[0][0]).toBeCloseTo(0.6, 6);
    expect(r.vectors[0][1]).toBeCloseTo(0.8, 6);
  });

  it("throws when the batch comes back short", async () => {
    mockOllama([[1, 0]]);
    const p = createOllamaProvider({});

    await expect(p.embed(["a", "b"], "document")).rejects.toThrow(
      /1 embeddings for 2 inputs/,
    );
  });
});

describe("provider selection", () => {
  it("returns null when nothing is configured — the shipped default", () => {
    expect(createEmbeddingProvider(undefined, { env: {} })).toBeNull();
  });

  it("reports a configured provider whose key is missing, rather than going quiet", () => {
    // "Configured but broken" and "deliberately off" look identical from the
    // outside otherwise — and a store that thinks it has semantic search and
    // does not is exactly the kind of silent gap this codebase keeps finding.
    const reasons: string[] = [];
    const p = createEmbeddingProvider(
      {
        provider: "voyage",
        model: null,
        dimensions: null,
        api_key_env: "VOYAGE_API_KEY",
        batch_size: 8,
      },
      { env: {}, onUnavailable: (r) => reasons.push(r) },
    );

    expect(p).toBeNull();
    expect(reasons[0]).toMatch(/VOYAGE_API_KEY/);
  });

  it("builds voyage when the named key variable is set", () => {
    const p = createEmbeddingProvider(
      {
        provider: "voyage",
        model: "voyage-4-lite",
        dimensions: 512,
        api_key_env: "MY_KEY",
        batch_size: 8,
      },
      { env: { MY_KEY: "secret" } },
    );

    expect(p?.model).toBe("voyage-4-lite");
  });

  it("builds ollama with no key at all", () => {
    const p = createEmbeddingProvider(
      {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: null,
        api_key_env: "UNUSED",
        batch_size: 8,
      },
      { env: {} },
    );

    expect(p?.model).toBe("nomic-embed-text");
  });

  it("honours the env kill-switch in both directions", () => {
    expect(resolveEmbeddingProviderType("voyage", { OPENMEMORY_EMBEDDING_PROVIDER: "none" }))
      .toBeNull();
    expect(resolveEmbeddingProviderType(null, { OPENMEMORY_EMBEDDING_PROVIDER: "ollama" }))
      .toBe("ollama");
    expect(resolveEmbeddingProviderType("voyage", { OPENMEMORY_EMBEDDING_PROVIDER: "nonsense" }))
      .toBe("voyage");
  });
});

describe("the provider carries its own noise floor", () => {
  /**
   * Cosine has no natural zero, so a query a store cannot answer still scores
   * every fact — measured at 0.42–0.48 against nomic-embed-text, against 0.54
   * and 0.73 for queries that did have an answer. The number that separates
   * them belongs to the model, so it lives with the model rather than in a
   * constant applied to whichever model happens to be configured.
   */
  it("ships the measured value for the family it was measured on", () => {
    expect(createOllamaProvider({ model: "nomic-embed-text" }).defaultMinSimilarity).toBe(0.5);
  });

  it("offers no floor for a model nobody has measured", () => {
    // Not 0.5 "because it is probably similar". A wrong floor silently deletes
    // correct results, which is worse than the flooding it would prevent.
    expect(createOllamaProvider({ model: "mxbai-embed-large" }).defaultMinSimilarity)
      .toBeUndefined();
    expect(createVoyageProvider({ apiKey: "k" }).defaultMinSimilarity).toBeUndefined();
  });
});
