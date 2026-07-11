import { safeFetch } from "./fetch-url.ts";
import { extractVsixThemes } from "./unzip-vsix.ts";
import { convertVscodeTheme } from "./vscode-converter.ts";
import { validatePpmTheme, sanitizeName } from "./validate-theme.ts";
import { insertTheme } from "./theme-repo.ts";
import type { PpmTheme } from "../../web/theme/types.ts";

const MAX_JSON_BYTES = 5 * 1024 * 1024;   // 5 MB
const MAX_VSIX_BYTES = 20 * 1024 * 1024;  // 20 MB

export type ImportSource = "json" | "url" | "vsix" | "upload";

export interface ImportPayload {
  source: ImportSource;
  value: string;
  name?: string;
}

/** Parse a JSON theme string with a size guard, convert + validate + store. */
function importFromJsonString(value: string, source: string, nameHint?: string): PpmTheme[] {
  if (value.length > MAX_JSON_BYTES) throw new Error("JSON exceeds 5 MB limit");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON");
  }
  const theme = convertVscodeTheme(parsed, nameHint);
  validatePpmTheme(theme);
  return [insertTheme(theme, source)];
}

/** Extract, convert, validate, and store every theme in a .vsix byte buffer. */
async function importFromVsixBytes(bytes: Uint8Array, source: string, nameHint?: string): Promise<PpmTheme[]> {
  const extracted = await extractVsixThemes(bytes);
  const stored: PpmTheme[] = [];
  for (const item of extracted) {
    const theme = convertVscodeTheme(item.json, nameHint ? `${sanitizeName(nameHint)} ${item.label}` : item.label);
    validatePpmTheme(theme);
    stored.push(insertTheme(theme, source));
  }
  if (stored.length === 0) throw new Error("No valid themes to import");
  return stored;
}

function looksLikeVsix(url: string, contentType: string): boolean {
  if (/\.vsix($|\?)/i.test(url) || /vspackage/i.test(url)) return true;
  return /zip|vsix|octet-stream/i.test(contentType);
}

/** Import one or more themes from the given source. Returns stored PpmThemes. */
export async function importThemes(payload: ImportPayload): Promise<PpmTheme[]> {
  const { source, value, name } = payload;
  if (typeof value !== "string" || value.length === 0) throw new Error("value is required");

  switch (source) {
    case "json":
    case "upload":
      return importFromJsonString(value, source, name);

    case "vsix": {
      const res = await safeFetch(value, { maxBytes: MAX_VSIX_BYTES });
      return importFromVsixBytes(res.bytes, "vsix", name);
    }

    case "url": {
      const res = await safeFetch(value, { maxBytes: MAX_VSIX_BYTES });
      if (looksLikeVsix(res.finalUrl, res.contentType)) {
        return importFromVsixBytes(res.bytes, "url", name);
      }
      const text = new TextDecoder().decode(res.bytes);
      return importFromJsonString(text, "url", name);
    }

    default:
      throw new Error("Unknown import source");
  }
}
