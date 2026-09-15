/**
 * Colouring by what a name *is*, not by what it looks like.
 *
 * Monaco's own tokenizer is a set of regular expressions: it can tell a keyword
 * from a string, but `Foo` is just an identifier whether it is a class, a type
 * parameter or a local. The language server already knows which, and semantic
 * tokens are how it says so. This is the same division VS Code uses — the regex
 * grammar paints immediately, the server's answer refines it a moment later.
 *
 * Registration has to be lazy, and that is the whole reason this is not in
 * `register-providers.ts` with the rest. Every other provider can be registered
 * for a language before any server exists, because its request and response
 * shapes are fixed. A semantic token is an *index* into a legend that only the
 * server's initialize result contains, so a provider registered before a server
 * connects would have nothing to decode with — and decoding with the wrong
 * legend is worse than not colouring at all, because every token comes out as
 * some other, plausible-looking kind.
 */
import type * as MonacoType from "monaco-editor";
import { lspDocumentFor, type LspDocument } from "./lsp-documents";

export interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

/** What a server advertises in `initialize`, as much of it as matters here. */
export interface SemanticTokensCapability {
  legend?: SemanticTokensLegend;
  full?: boolean | { delta?: boolean };
  range?: boolean;
}

/** The relative-encoded token array, straight off the wire. */
interface LspSemanticTokens {
  resultId?: string;
  data: number[];
}

/** A server's answer to a delta request when nothing was rebuilt. */
interface LspSemanticTokensDelta {
  resultId?: string;
  edits: Array<{ start: number; deleteCount: number; data?: number[] }>;
}

interface Registration {
  /** The legend this provider decodes with, to detect a server swap. */
  fingerprint: string;
  disposable: MonacoType.IDisposable;
}

const registrations = new Map<string, Registration>();

/**
 * Read the legend a server offered, or nothing if it offered none.
 *
 * A server may advertise the provider without a legend, or with an empty one.
 * Both mean there is nothing to decode with, so there is nothing to register.
 */
export function semanticTokensLegendOf(capabilities: Record<string, unknown>): SemanticTokensLegend | null {
  const provider = capabilities.semanticTokensProvider as SemanticTokensCapability | undefined;
  const legend = provider?.legend;
  if (!legend || !Array.isArray(legend.tokenTypes) || legend.tokenTypes.length === 0) return null;
  return { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers ?? [] };
}

/** True when the server will answer `semanticTokens/full/delta`. */
export function supportsDelta(capabilities: Record<string, unknown>): boolean {
  const full = (capabilities.semanticTokensProvider as SemanticTokensCapability | undefined)?.full;
  return typeof full === "object" && full?.delta === true;
}

/**
 * Register the provider for a language, using this server's legend.
 *
 * Idempotent for a given legend. If a different server takes over a language
 * and brings a different legend, the old provider is disposed and replaced —
 * keeping it would decode the new server's indices against the old table.
 */
export function registerSemanticTokens(
  monaco: typeof MonacoType,
  language: string,
  legend: SemanticTokensLegend,
): void {
  const fingerprint = JSON.stringify(legend);
  const existing = registrations.get(language);
  if (existing?.fingerprint === fingerprint) return;
  existing?.disposable.dispose();

  const disposable = monaco.languages.registerDocumentSemanticTokensProvider(language, {
    getLegend: () => legend,

    provideDocumentSemanticTokens: async (model, lastResultId) => {
      const document = lspDocumentFor(model);
      if (!document) return null;

      const result = await requestTokens(document, model, lastResultId);
      if (!result) return null;

      // Monaco's own encoding is LSP's, so the numbers need no rewriting — only
      // the array type differs.
      if ("edits" in result) {
        return {
          resultId: result.resultId,
          edits: result.edits.map((edit) => ({
            start: edit.start,
            deleteCount: edit.deleteCount,
            data: edit.data ? new Uint32Array(edit.data) : undefined,
          })),
        };
      }
      return { resultId: result.resultId, data: new Uint32Array(result.data) };
    },

    // Nothing is held per result: the server keeps its own previous result under
    // the id, and asking it to forget one is optional in the protocol.
    releaseDocumentSemanticTokens: () => {},
  });

  registrations.set(language, { fingerprint, disposable });
}

async function requestTokens(
  document: LspDocument,
  model: MonacoType.editor.ITextModel,
  lastResultId: string | null,
): Promise<LspSemanticTokens | LspSemanticTokensDelta | null> {
  const status = document.connection.statusOf(document.path);
  if (status?.state !== "ready") return null;

  const textDocument = { uri: model.uri.toString() };
  const useDelta = Boolean(lastResultId) && supportsDelta(status.capabilities);

  try {
    if (useDelta) {
      return await document.connection.request(document.path, "textDocument/semanticTokens/full/delta", {
        textDocument,
        previousResultId: lastResultId,
      });
    }
    return await document.connection.request(document.path, "textDocument/semanticTokens/full", {
      textDocument,
    });
  } catch {
    // Same rule as every other provider: a rejection makes Monaco stop asking,
    // and losing the colouring for the rest of the session is worse than one
    // stale paint.
    return null;
  }
}

/** Drop every registration. Exported for tests; nothing in the app unregisters. */
export function resetSemanticTokens(): void {
  for (const registration of registrations.values()) registration.disposable.dispose();
  registrations.clear();
}
