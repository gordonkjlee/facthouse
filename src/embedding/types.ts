/**
 * Embedding provider interface.
 *
 * Separate from `IntelligenceProvider` on purpose: they fail differently, and
 * conflating them would import a retry mechanism this path does not need.
 * Extraction has a watermark, so a failed run must be *reported* or the events
 * it skipped are lost for good. Embeddings have no watermark — a fact with no
 * vector is self-describing, and the query for "facts missing an embedding" is
 * the retry queue. So there is no `degraded` flag here, and adding one would be
 * bookkeeping that can drift out of step with the rows it describes.
 */

/**
 * Whether the text being embedded is a stored document or a search query.
 *
 * Not a hint — a correctness requirement. Retrieval models are trained
 * asymmetrically and prepend different instructions per side: Voyage documents
 * this explicitly and says not to omit it, and `nomic-embed-text` requires
 * `search_query:` / `search_document:` prefixes for the same reason. Embedding
 * a query as a document returns a plausible vector, degrades every result, and
 * raises nothing.
 */
export type InputType = "query" | "document";

export interface EmbeddingResult {
  /** One vector per input, in input order. */
  vectors: Float32Array[];
  /** The model that produced them. Stored on every row — see `db/embeddings.ts`. */
  model: string;
  /** Vector length. Stored alongside the model, and filtered on at read time. */
  dimensions: number;
}

export interface EmbeddingProvider {
  /**
   * Embed a batch of texts.
   *
   * Throws on failure rather than returning a partial result. Consolidation
   * catches it, integrates the facts anyway, and leaves the missing rows to be
   * picked up next run — losing quality temporarily instead of losing facts
   * permanently.
   */
  embed(texts: string[], inputType: InputType): Promise<EmbeddingResult>;

  /** Model identifier as recorded on stored vectors. */
  readonly model: string;
  /** Configured output dimension. */
  readonly dimensions: number;

  /**
   * Cosine score below which this model's output is noise rather than a match,
   * or undefined when nobody has measured it for this model.
   *
   * Lives on the provider because it is a property of the model and nowhere
   * else knows which model is in play. Cosine has no natural zero: a query a
   * store cannot answer still scores every fact in a tight band — measured at
   * 0.42–0.48 for `nomic-embed-text` — so without a floor, search answers
   * questions it has no answer to. A comparison against the best result cannot
   * catch this, because in that band everything is close to the best.
   *
   * Undefined rather than a guessed number for an unmeasured model. Overridden
   * by `embedding.min_similarity`, which a store sets after measuring its own.
   */
  readonly defaultMinSimilarity?: number;
}
