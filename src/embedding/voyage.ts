/**
 * Voyage AI embedding provider.
 *
 * Voyage is the provider Anthropic recommends, because Anthropic ships no
 * embeddings endpoint of its own — which is the reason semantic search cannot
 * ride on the Claude subscription the rest of the intelligence runs on.
 *
 * Voyage models are Matryoshka: `output_dimension` truncates server-side, and
 * the vectors come back already normalised. That matters more here than as a
 * storage saving — the scan reads every vector on every query, so dimension is
 * the lever that decides how many facts fit in page cache.
 *
 * **Verified structurally, not against the live API.** There was no Voyage key
 * available when this was written, so the request shape, the `input_type`
 * plumbing, and the failure paths are covered against a mocked transport while
 * the Ollama provider carries the end-to-end verification. Anything that
 * depends on Voyage's actual responses — real dimensions, real quality — is
 * unproven until someone runs it with a key.
 */

import type { EmbeddingProvider, EmbeddingResult, InputType } from "./types.js";

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-4-lite";

export interface VoyageOpts {
  apiKey: string;
  model?: string;
  /** 256 | 512 | 1024 | 2048 on Matryoshka models. Omit for the model default. */
  dimensions?: number | null;
  timeoutMs?: number;
  /** Injection seam for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createVoyageProvider(opts: VoyageOpts): EmbeddingProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const doFetch = opts.fetchImpl ?? fetch;
  let dimensions = opts.dimensions ?? 0;

  // Measured against a seeded store, the same way the Ollama floor was: queries
  // with a real answer topped out at 0.401–0.622, queries the store knew nothing
  // about at 0.124–0.252. A wide, clean gap — Voyage scores unrelated text much
  // lower than nomic does, where the same measurement left barely 0.06 between
  // signal and noise.
  //
  // 0.30 rather than the midpoint: it clears every observed noise score while
  // sitting well under every observed signal one, and the sample is small enough
  // that erring towards keeping results is the right direction. A larger store
  // gives noise more chances to score high, so this is a permissive estimate.
  //
  // Measured on voyage-4-lite and applied to the voyage-4 family it shares
  // training with. An older or newer generation gets no floor rather than this
  // one — a number carried across a model it was never measured on is exactly
  // what putting it on the provider is meant to prevent.
  const defaultMinSimilarity = model.startsWith("voyage-4") ? 0.3 : undefined;

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

      const body: Record<string, unknown> = {
        input: texts,
        model,
        // Voyage's docs are explicit that this must not be omitted: a different
        // instruction is prepended per side, and getting it wrong degrades
        // retrieval without erroring.
        input_type: inputType,
      };
      if (opts.dimensions) body.output_dimension = opts.dimensions;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let json: { data?: Array<{ embedding: number[]; index: number }> };
      try {
        const res = await doFetch(ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(
            `voyage embed failed: ${res.status} ${await res.text().catch(() => "")}`.trim(),
          );
        }
        json = (await res.json()) as typeof json;
      } finally {
        clearTimeout(timer);
      }

      const data = json.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(
          `voyage returned ${data?.length ?? 0} embeddings for ${texts.length} inputs`,
        );
      }

      // Order by the API's own `index` rather than trusting array order. The
      // failure this prevents is silent: every fact after a reordering would
      // carry a different fact's vector, and nothing downstream could tell.
      const ordered = [...data].sort((a, b) => a.index - b.index);
      const vectors = ordered.map((d) => Float32Array.from(d.embedding));

      const got = vectors[0].length;
      if (dimensions === 0) dimensions = got;
      else if (got !== dimensions) {
        throw new Error(
          `voyage returned ${got}-dimension vectors, expected ${dimensions}`,
        );
      }

      return { vectors, model, dimensions };
    },
  };
}
