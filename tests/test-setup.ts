import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// Set PPM_HOME to isolated temp dir BEFORE any service imports
const testPpmHome = mkdtempSync(resolve(tmpdir(), "ppm-test-"));
process.env.PPM_HOME = testPpmHome;

// A shell inside an AI chat carries the chat's mark (`ai-chat-env.ts`), and `ppm db` refuses its
// data commands under it, so a run started from a chat must not inherit it. Tests that want the
// mark set it themselves.
delete process.env.PPM_AI_CHAT;

// Create subdirectories that services expect
mkdirSync(resolve(testPpmHome, "bin"), { recursive: true });
mkdirSync(resolve(testPpmHome, "extensions"), { recursive: true });
mkdirSync(resolve(testPpmHome, "bot"), { recursive: true });

// Now import services (they'll resolve to temp dir via getPpmDir())
import { setDb, openTestDb } from "../src/services/db.service.ts";
import { configService } from "../src/services/config.service.ts";

// Use in-memory DB for all tests (prevents polluting real DB)
setDb(openTestDb());

// Bring the config service up against that throwaway database. It refuses to persist until
// load() has run, because writing pristine defaults over a live instance once blanked the auth
// token and deleted every project — but here PPM_HOME is a fresh temp dir and the database is
// in-memory, so there is nothing to protect and fixtures write config legitimately.
configService.load();

// Disable auth for all tests
const config = (configService as any).config;
config.auth.enabled = false;

// Vite's `?url` import is a string (the asset's URL). Bun 1.3.12 happened to answer it with the
// file's path, but 1.4.4 loads `x.css?url` as a CSS module and the default export is `{}`, so a
// `link.href` built from it was no URL at all (`file-icons.test.ts`). Answer it the way Vite does.
// A real file rather than a plugin namespace: 1.3.12 cannot resolve a namespaced module from an
// importer loaded with a query (`file-icons.tsx?fresh-sheet`).
const viteUrlDir = resolve(testPpmHome, "vite-url-imports");
mkdirSync(viteUrlDir, { recursive: true });
Bun.plugin({
  name: "vite-url-import",
  setup(build) {
    build.onResolve({ filter: /\?url$/ }, (args) => {
      const url = args.path.replace(/\?url$/, "");
      const file = resolve(viteUrlDir, `${Bun.hash(url).toString(16)}.js`);
      writeFileSync(file, `export default ${JSON.stringify(url)};\n`);
      return { path: file };
    });
  },
});

// A DOM for the whole process, installed before any module is imported. See
// `installDomForProcess` for why nothing later is early enough.
import { installDomForProcess } from "./helpers/react-dom.tsx";
installDomForProcess();

process.on("exit", () => {
  try { rmSync(testPpmHome, { recursive: true, force: true }); } catch {}
});
