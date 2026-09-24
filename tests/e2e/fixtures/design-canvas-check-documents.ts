/**
 * Prints what the canvas self-check e2e serves, as JSON on stdout: the broken design with
 * the real bridge tag injected (exactly as the preview route does, first child of `<head>`),
 * a repaired copy, the design CSP, and the screenshot library's source the parent sends.
 *
 * Run by `tests/e2e/design-canvas-check-e2e.mjs` under Bun, so the Node side needs no
 * TypeScript loader. Imports nothing that opens a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeTag } from "../../../src/services/design/bridge/bridge-script.ts";
import { buildDesignCsp } from "../../../src/services/design/preview/design-csp.ts";

const dir = join(import.meta.dir, "design-canvas-check");
const nonce = process.argv[2] ?? "";
if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new Error("usage: design-canvas-check-documents.ts <nonce>");

const html = readFileSync(join(dir, "index.html"), "utf8");
const tag = bridgeTag({ nonce, gen: "0123456789abcdef", cssGens: {}, file: "index.html", instrumented: false });
const withBridge = (source: string): string => source.replace(/<head>/i, `<head>${tag}`);
// The repair: the status bar starts after the activity bar's column instead of taking it.
const repaired = html.replace("</head>", "<style>.status-bar { grid-column: 2 / -1; }</style>\n</head>");

process.stdout.write(JSON.stringify({
  broken: withBridge(html),
  repaired: withBridge(repaired),
  css: readFileSync(join(dir, "styles.css"), "utf8"),
  // The whole fixture origin: `../tokens.css` sits one level up, as the preview route aliases it.
  csp: buildDesignCsp("canvas-check.test/"),
  tokens: readFileSync(join(dir, "tokens.css"), "utf8"),
  lib: readFileSync(require.resolve("modern-screenshot/dist/index.js"), "utf8"),
}));
