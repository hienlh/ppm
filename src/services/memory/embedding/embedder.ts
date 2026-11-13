/** What a memory text is embedded as: the search query, or a stored memory. */
export type EmbedKind = "query" | "passage";

/**
 * A source of vectors. `model` names the source as well as the model
 * (`local:Xenova/multilingual-e5-small@q8`, `api:<url>#<model>`), so vectors from two sources
 * are never compared (8.5).
 */
export interface Embedder {
  model: string;
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
}

/** Texts per request to an embedding host. */
export const EMBED_BATCH_SIZE = 16;

/** The local model: multilingual (Vietnamese + English), 384 dims, CPU, measured in the spike. */
export const LOCAL_EMBED_MODEL = "Xenova/multilingual-e5-small";
export const LOCAL_EMBED_DTYPE = "q8";

/** e5 models were trained with `query: ` / `passage: ` prefixes and score worse without them. */
export function isE5Model(model: string): boolean {
  return /(^|[^a-z0-9])e5([^a-z0-9]|$)/i.test(model);
}

export function applyE5Prefix(texts: string[], kind: EmbedKind, model: string): string[] {
  if (!isE5Model(model)) return texts;
  return texts.map((t) => `${kind}: ${t}`);
}

/** The reason shown while no embedding source is configured. */
export const EMBEDDING_OFF_REASON = "No embedding source is set; search uses full text only";
