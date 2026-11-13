import { applyE5Prefix, type EmbedKind, type Embedder } from "./embedder.ts";

export const API_EMBED_TIMEOUT_MS = 15_000;

export interface ApiEmbedderOptions {
  /** Base URL of an OpenAI-compatible API, e.g. `https://api.openai.com/v1`. */
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

/** An OpenAI-compatible `POST <url>/embeddings` (9.3). Runs on `fetch`, off the main thread's CPU. */
export class ApiEmbedder implements Embedder {
  readonly model: string;
  private readonly endpoint: string;

  constructor(private readonly opts: ApiEmbedderOptions) {
    this.model = `api:${opts.url}#${opts.model}`;
    this.endpoint = `${opts.url.replace(/\/+$/, "")}/embeddings`;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const timeoutMs = this.opts.timeoutMs ?? API_EMBED_TIMEOUT_MS;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.opts.model, input: applyE5Prefix(texts, kind, this.opts.model) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`Embedding API ${this.endpoint} timed out after ${timeoutMs} ms`);
      }
      throw new Error(`Embedding API ${this.endpoint} unreachable: ${(err as Error)?.message ?? err}`);
    }

    const raw = await res.text().catch(() => "");
    let body: any = null;
    try {
      body = JSON.parse(raw);
    } catch {}

    if (!res.ok) {
      const msg = errorMessage(body) ?? (raw.trim().slice(0, 500) || res.statusText);
      throw new Error(`Embedding API HTTP ${res.status}: ${msg}`);
    }

    const data = body?.data;
    if (!Array.isArray(data)) throw new Error(`Embedding API ${this.endpoint} answered without a data array`);
    if (data.length !== texts.length) {
      throw new Error(`Embedding API ${this.endpoint} returned ${data.length} vectors for ${texts.length} texts`);
    }
    const ordered = data.every((d: any) => typeof d?.index === "number")
      ? [...data].sort((a: any, b: any) => a.index - b.index)
      : data;
    return ordered.map((d: any) => {
      if (!Array.isArray(d?.embedding)) throw new Error(`Embedding API ${this.endpoint} returned an item without an embedding`);
      return Float32Array.from(d.embedding as number[]);
    });
  }
}

/** OpenAI puts it at `error.message`; other servers use `error` or `message` as a string. */
function errorMessage(body: any): string | null {
  if (!body || typeof body !== "object") return null;
  if (typeof body.error?.message === "string") return body.error.message;
  if (typeof body.error === "string") return body.error;
  if (typeof body.message === "string") return body.message;
  if (typeof body.detail === "string") return body.detail;
  return null;
}
