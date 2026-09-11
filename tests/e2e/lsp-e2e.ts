/**
 * Drives the whole server-side LSP stack against a real language server.
 *
 * Not a `bun test` file: it needs `typescript-language-server` and a matching
 * TypeScript on disk, which is an external binary and a network install, so it
 * follows the same manual-script convention as the remote-desktop e2e. The
 * unit tests cover the logic against a fake server; this proves the real thing
 * answers, which is the part a fake can never establish.
 *
 *   bun tests/e2e/lsp-e2e.ts
 *
 * It sets up a throwaway project under the system temp directory, installs the
 * server there if it is missing, and cleans up after itself.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspManager, isUnavailable, type LspHandle } from "../../src/services/lsp/lsp-manager.ts";
import { semanticTokensLegendOf } from "../../src/web/lib/lsp/lsp-semantic-tokens.ts";
import { pathToFileUri } from "../../src/shared/lsp-uri.ts";

const PROJECT = join(tmpdir(), "ppm-lsp-e2e");
const SAMPLE = join(PROJECT, "src", "sample.ts");

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  }
}

async function setup(): Promise<void> {
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(join(PROJECT, "src"), { recursive: true });

  writeFileSync(join(PROJECT, "package.json"), JSON.stringify({ name: "ppm-lsp-e2e", private: true }, null, 2));
  writeFileSync(
    join(PROJECT, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" } }, null, 2),
  );
  // Line and column numbers below are counted against this exact text, so
  // editing it means re-counting them.
  writeFileSync(
    SAMPLE,
    [
      "interface User { name: string; age: number; }",              // line 0
      "",                                                            // line 1
      "export function greet(user: User): string {",                 // line 2
      '  return "Hello " + user.name;',                              // line 3
      "}",                                                           // line 4
      "",                                                            // line 5
      'const who: User = { name: "Ada", age: 36 };',                 // line 6
      "const shouted = who.name.toUpperCase();",                     // line 7
      "const broken: number = who.name;",                            // line 8 — a real type error
      "",
    ].join("\n"),
  );

  if (!existsSync(join(PROJECT, "node_modules", ".bin", "typescript-language-server"))) {
    console.log("Installing typescript-language-server (one off, needs network)...");
    // typescript@5 on purpose: the 7.x line ships no tsserver.js and the
    // server refuses to start against it.
    const install = Bun.spawn(["bun", "add", "typescript-language-server", "typescript@5"], {
      cwd: PROJECT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await install.exited) !== 0) {
      console.error(await new Response(install.stderr).text());
      throw new Error("install failed; run this script with network access");
    }
  }
}

async function main(): Promise<void> {
  await setup();

  const manager = new LspManager();
  const acquired = await manager.acquire(PROJECT, SAMPLE, "e2e");
  if (isUnavailable(acquired)) {
    console.error(`Could not start a server: ${acquired.message}`);
    if (acquired.server) console.error(`Install with: ${acquired.server.installHint}`);
    process.exit(1);
  }

  const { session, language } = acquired as LspHandle;
  console.log(`\n${session.definition.displayName} rooted at ${session.rootPath}\n`);

  check("resolves the project-local server, not a global one", session.definition.command === "typescript-language-server");
  check("detects the language", language === "typescript", language);
  check("roots at the tsconfig.json", session.rootPath === PROJECT, session.rootPath);
  check("negotiates real capabilities", Boolean(session.serverCapabilities.completionProvider));

  const uri = pathToFileUri(SAMPLE);
  const text = await Bun.file(SAMPLE).text();

  const diagnostics: unknown[] = [];
  manager.onNotification((_key, method, params) => {
    if (method === "textDocument/publishDiagnostics") {
      diagnostics.push(...((params as { diagnostics?: unknown[] }).diagnostics ?? []));
    }
  });

  session.notify("textDocument/didOpen", { textDocument: { uri, languageId: language, version: 1, text } });
  // tsserver loads the program before it answers usefully.
  await Bun.sleep(3000);

  // `who.name.` — completion of string members, at the dot on line 7.
  const completion = (await session.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 7, character: 25 },
    context: { triggerKind: 2, triggerCharacter: "." },
  })) as { items?: Array<{ label: string }> } | Array<{ label: string }>;
  const items = Array.isArray(completion) ? completion : (completion?.items ?? []);
  const labels = items.map((i) => i.label);
  check("completes string members after a dot", labels.includes("toUpperCase"), labels.slice(0, 10));

  // Member completion of the interface, at the dot on line 3.
  const members = (await session.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 3, character: 25 },
    context: { triggerKind: 2, triggerCharacter: "." },
  })) as { items?: Array<{ label: string }> } | Array<{ label: string }>;
  const memberLabels = (Array.isArray(members) ? members : (members?.items ?? [])).map((i) => i.label);
  check("completes interface members from the type", memberLabels.includes("name") && memberLabels.includes("age"), memberLabels.slice(0, 10));

  const hover = (await session.request("textDocument/hover", {
    textDocument: { uri },
    position: { line: 2, character: 17 },
  })) as { contents?: { value?: string } };
  check(
    "hovers with the resolved signature",
    Boolean(hover?.contents?.value?.includes("function greet(user: User): string")),
    hover?.contents?.value,
  );

  const definition = (await session.request("textDocument/definition", {
    textDocument: { uri },
    position: { line: 2, character: 31 },
  })) as Array<{ uri: string; range: { start: { line: number } } }>;
  check(
    "resolves a definition to the declaring line",
    definition?.[0]?.range.start.line === 0,
    definition,
  );

  const references = (await session.request("textDocument/references", {
    textDocument: { uri },
    position: { line: 0, character: 10 },
    context: { includeDeclaration: false },
  })) as unknown[];
  check("finds references to a type", Array.isArray(references) && references.length >= 2, references?.length);

  const symbols = (await session.request("textDocument/documentSymbol", {
    textDocument: { uri },
  })) as Array<{ name: string }>;
  check("lists document symbols", symbols?.some((s) => s.name === "greet"), symbols?.map((s) => s.name));

  // The type error on line 8 is what proves diagnostics are real analysis and
  // not a syntax check.
  check(
    "publishes a real type error",
    diagnostics.some((d) => typeof (d as { message?: string }).message === "string" &&
      (d as { message: string }).message.includes("not assignable")),
    diagnostics.map((d) => (d as { message?: string }).message),
  );

  // Semantic tokens: a legend, then indices into it. The whole feature is a
  // silent no-op if either half is missing, so both are checked here rather
  // than trusted.
  const legend = semanticTokensLegendOf(session.serverCapabilities);
  check("advertises a semantic tokens legend", legend !== null, legend?.tokenTypes?.length);

  const tokens = (await session.request("textDocument/semanticTokens/full", {
    textDocument: { uri },
  })) as { data?: number[] } | null;
  const data = tokens?.data ?? [];
  check("returns semantic tokens for the file", data.length > 0 && data.length % 5 === 0, data.length);

  if (legend && data.length >= 5) {
    // The first token in the file is `User` on line 0 — an interface. Decoding
    // it proves the indices mean what the legend says, which is the part that
    // silently mis-colours everything when it is wrong.
    const types = new Set<string>();
    for (let i = 0; i < data.length; i += 5) {
      const name = legend.tokenTypes[data[i + 3]!];
      if (name) types.add(name);
    }
    check(
      "decodes token types the theme has colours for",
      types.has("interface") && types.has("function"),
      [...types],
    );
  }

  await manager.disposeAll();
  check("stops the server", session.state === "stopped", session.state);

  rmSync(PROJECT, { recursive: true, force: true });

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
