/**
 * Ollama embedding provider — a local HTTP service, no API key, no native
 * dependency in this package.
 *
 * This is the provider the pipeline was verified against end to end, because
 * it is the one that can be run without credentials. `nomic-embed-text` is
 * 768-dimension and benchmarks comparably to hosted small models.
 *
 * It asks something of the user (Ollama installed and running) rather than
 * nothing, which is why it is not a default — but it asks for no key and no
 * per-token billing, which makes it the cheapest way to actually try semantic
 * search before deciding whether to pay for it.
 */

import type { EmbeddingProvider, EmbeddingResult, InputType } from "./types.js";

export const DEFAULT_HOST = "http://localhost:11434";
export const DEFAULT_MODEL = "nomic-embed-text";

export function ollamaHost(host?: string): string {
  return (host ?? DEFAULT_HOST).replace(/\/+$/, "");
}

export async function probeOllama(
  host?: string,
  timeoutMs = 2_000,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; host: string; models: string[] }> {
  const normalised = ollamaHost(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${normalised}/api/tags`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, host: normalised, models: [] };
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = Array.isArray(json.models)
      ? json.models.map((m) => m.name ?? "").filter(Boolean)
      : [];
    return { ok: true, host: normalised, models };
  } catch {
    return { ok: false, host: normalised, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

export interface OllamaOpts {
  host?: string;
  model?: string;
  /** Truncate to this many dimensions. Omit to keep the model's native size. */
  dimensions?: number | null;
  timeoutMs?: number;
}

/**
 * Task prefixes for the nomic-embed family.
 *
 * These models are trained with an instruction prefix per side, and omitting it
 * costs retrieval quality silently. Applied only to models that ask for it —
 * prefixing a model that was not trained on prefixes makes results worse, so
 * this is keyed on the model name rather than applied blindly.
 */
function applyPrefix(model: string, text: string, inputType: InputType): string {
  if (!model.startsWith("nomic-embed")) return text;
  return inputType === "query"
    ? `search_query: ${text}`
    : `search_document: ${text}`;
}

export function createOllamaProvider(opts: OllamaOpts = {}): EmbeddingProvider {
  const host = ollamaHost(opts.host);
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  // Native dimension is unknown until the first response, so `dimensions` is
  // resolved lazily and then frozen — see the check in `embed`.
  let dimensions = opts.dimensions ?? 0;

  // Measured, not assumed, and only for the family it was measured on. Against
  // a seeded store, queries with a real answer scored 0.54 and 0.73 while
  // queries the store knew nothing about topped out at 0.48 and 0.42. Anything
  // at or below 0.5 is noise for this family; a different model would need its
  // own measurement, so it gets no number rather than this one.
  const defaultMinSimilarity = model.startsWith("nomic-embed") ? 0.5 : undefined;

  return {
    defaultMinSimilarity,
    get model() {
      return model;
    },
    get dimensions() {
      return dimensions;
    },

    async embed(texts: string[], inputType: InputType): Promise<EmbeddingResult> {
      if (texts.length === 0) {
        return { vectors: [], model, dimensions };
      }

      const input = texts.map((t) => applyPrefix(model, t, inputType));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let json: { embeddings?: number[][] };
      try {
        const res = await fetch(`${host}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(
            `ollama embed failed: ${res.status} ${await res.text().catch(() => "")}`.trim(),
          );
        }
        json = (await res.json()) as { embeddings?: number[][] };
      } finally {
        clearTimeout(timer);
      }

      const raw = json.embeddings;
      if (!Array.isArray(raw) || raw.length !== texts.length) {
        // A short batch would silently misalign vectors with facts — every
        // fact after the gap would carry someone else's embedding.
        throw new Error(
          `ollama returned ${raw?.length ?? 0} embeddings for ${texts.length} inputs`,
        );
      }

      const vectors = raw.map((v) => truncate(Float32Array.from(v), opts.dimensions));

      // Freeze the dimension on first use, then hold the provider to it. A
      // model that changed size underneath us would otherwise write vectors
      // that cannot be compared with the ones already stored.
      const got = vectors[0].length;
      if (dimensions === 0) dimensions = got;
      else if (got !== dimensions) {
        throw new Error(
          `ollama returned ${got}-dimension vectors, expected ${dimensions}`,
        );
      }

      return { vectors, model, dimensions };
    },
  };
}

/**
 * Truncate to the configured dimension and re-normalise.
 *
 * Renormalising is what makes truncation safe: a prefix of a unit vector is not
 * a unit vector, so cosine similarity over unnormalised prefixes compares
 * magnitudes as well as directions and quietly biases toward whichever vectors
 * happen to retain more length.
 *
 * Only sound on models trained for it (Matryoshka representation learning).
 * For others this is a plain prefix and loses information, which is why the
 * default is to keep the native size.
 */
function truncate(v: Float32Array, dims: number | null | undefined): Float32Array {
  if (!dims || dims >= v.length) return v;
  const out = v.slice(0, dims);
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= norm;
  }
  return out;
}
