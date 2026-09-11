/**
 * Vendor the vscode-icons file icon theme into a module the browser can use.
 *
 * The icons are the real ones from `vscode-icons-team.vscode-icons`, taken from
 * the Iconify collection generated out of that extension, and the *mapping* is
 * the extension's own (`vscode-icons-js`) rather than a hand-written guess — so
 * `.spec.ts` gets the test glyph, `go.sum` gets the Go one, and a filename with
 * a dedicated icon (`package.json`, `Dockerfile`, `.prettierrc`) gets it.
 *
 * Both of those are **build-time** dependencies. Resolving names at run time
 * would mean shipping the extension's four lookup tables (77 KB of JS) and,
 * worse, the 1595 icon bodies (about 1.3 MB) to draw a tree that shows perhaps
 * forty distinct glyphs. So this script asks the tables which icon each name
 * PPM cares about resolves to, and emits only those bodies.
 *
 * The coverage list below is deliberately generous but finite: anything not on
 * it falls back to the theme's own `default-file`, which is what the extension
 * itself does for an unknown type. Add a line and re-run:
 *
 *   bun scripts/gen-file-icons.ts
 */
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from "vscode-icons-js";
// Reaching past the entry point on purpose: this table is the set of *double*
// extensions the theme knows (`spec.ts`, `d.ts`, `stories.tsx`, `js.map`), and
// those are the glyphs a TypeScript repository shows most after `.ts` itself.
// Hand-listing them would drift; if the path ever moves, this script fails
// loudly at generation time rather than quietly emitting worse icons.
import { FileExtensions2ToIcon } from "vscode-icons-js/dist/generated/FileExtensions2ToIcon";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT_TS = resolve(import.meta.dir, "../src/web/lib/file-icons.generated.ts");
const OUT_CSS = resolve(import.meta.dir, "../src/web/styles/file-icons.generated.css");

/**
 * A glyph bigger than this is dropped, and whatever asked for it falls back to
 * the neutral default.
 *
 * The set is extremely skewed — the median body is ~1 KB and `file-type-composer`
 * alone is 83 KB, because some of these are detailed illustrations rather than
 * icons. At the 16px a file tree draws them at, that detail is invisible; all it
 * costs is download. `KEEP_ANY_SIZE` exempts the few worth paying for anyway.
 *
 * 5000 rather than something tighter because the distribution has no useful gap
 * below it, and a tight budget cuts by weight rather than by worth: at 1800,
 * `.tsx` (`file-type-reactts`, 1833 bytes — 33 over) drew the blank-page default,
 * and so did `.jsx` (1833), `.go` (1825) and `.rs` (3957). Everything above 5000
 * really is an illustration. The 39 extra glyphs cost 25 KiB brotli.
 */
const MAX_BODY_BYTES = 5000;

/**
 * Keys the mapping names that the collection spells differently.
 *
 * vscode-icons revises a glyph by publishing it under a numbered name, and the
 * two packages are versioned apart — so the mapping can hand back a name the
 * collection no longer has. The script reports every unresolved key rather than
 * dropping it quietly, and this is where the answer goes. `Makefile` has no
 * glyph in the collection at all and falls back to the default on purpose.
 */
const ALIASES: Record<string, string> = {
  "file-type-pdf": "file-type-pdf2",
};

/** Languages common enough to keep whatever they weigh. */
const KEEP_ANY_SIZE = new Set(
  `file-type-ruby file-type-perl file-type-groovy file-type-maven file-type-http
   file-type-pdf2`
    .trim()
    .split(/\s+/),
);

/**
 * What the mapping should have said.
 *
 * `vscode-icons-js` is versioned apart from the artwork and its tables are the
 * older half: the collection has `file-type-bun`, `file-type-dotenv`,
 * `file-type-bazel` and thirty more that no table points at, so `Dockerfile`,
 * `bun.lock`, `.env.local`, `Rakefile` and every `.mts` file drew the blank-page
 * default while the right glyph sat unused in the bundle. A name here wins over
 * whatever the mapping answers — including where the mapping answers *wrongly*,
 * which is `bunfig.toml` getting the generic TOML glyph.
 *
 * Every value is checked against the collection at generation time, so a key
 * that stops existing is reported rather than silently drawing nothing. Some
 * names are deliberately absent: `Makefile` has no glyph at all, and `LICENSE`
 * (23 KB) and `file.pug` (6 KB) are over the budget below.
 */
const OVERRIDES: Record<string, string> = {
  // Bun, which is what this project is built with.
  "bun.lock": "file-type-bun",
  "bun.lockb": "file-type-bun",
  "bunfig.toml": "file-type-bunfig",
  // Containers.
  Dockerfile: "file-type-docker",
  dockerfile: "file-type-docker",
  ".dockerignore": "file-type-docker",
  Vagrantfile: "file-type-vagrant",
  // Environment files, which the tables know only as a bare `.env`.
  ".env.local": "file-type-dotenv",
  ".env.development": "file-type-dotenv",
  ".env.production": "file-type-dotenv",
  ".env.example": "file-type-dotenv",
  ".env.test": "file-type-dotenv",
  // Build systems.
  "meson.build": "file-type-meson",
  BUILD: "file-type-bazel",
  WORKSPACE: "file-type-bazel",
  Justfile: "file-type-just",
  Procfile: "file-type-procfile",
  gradlew: "file-type-gradle",
  "build.gradle.kts": "file-type-gradle",
  // Per-language lockfiles and manifests.
  "Cargo.lock": "file-type-rust",
  "go.work": "file-type-go-package",
  Gemfile: "file-type-ruby",
  "Gemfile.lock": "file-type-ruby",
  Rakefile: "file-type-rake",
  Pipfile: "file-type-python",
  "Pipfile.lock": "file-type-python",
  "poetry.lock": "file-type-poetry",
  "pytest.ini": "file-type-pytest",
  "mix.exs": "file-type-elixir",
  // Extensions the tables never learned.
  mts: "file-type-typescript",
  cts: "file-type-typescript",
  cjs: "file-type-js",
  jsonl: "file-type-json",
  pyi: "file-type-python",
  kts: "file-type-kotlin",
  exs: "file-type-elixir",
  ini: "file-type-ini",
  graphql: "file-type-graphql",
  proto: "file-type-protobuf",
  tif: "file-type-image",
  rest: "file-type-rest",
  tfvars: "file-type-terraform",
  npmrc: "file-type-npm",
  nvmrc: "file-type-node",
  apk: "file-type-binary",
  deb: "file-type-binary",
  rpm: "file-type-binary",
};

/** Extensions worth a glyph of their own. */
const EXTENSIONS = `
ts mts cts tsx js mjs cjs jsx json jsonc json5 jsonl map
html htm ejs hbs handlebars pug css scss sass less styl vue svelte astro
go py pyi rb php java jar kt kts scala rs c h cpp cc hpp cs swift
dart lua pl r ex exs clj groovy gradle vb vbs ps1 bat cmd
sh bash zsh fish
yml yaml toml ini cfg conf env properties xml plist csv tsv
xls xlsx doc docx pdf
sql db sqlite sqlite3 prisma graphql gql proto
png jpg jpeg gif svg webp avif ico bmp tif tiff
mp4 webm mov avi mkv mp3 wav ogg flac m4a
woff woff2 ttf otf eot
zip tar gz tgz bz2 xz 7z rar exe dll so bin wasm apk deb rpm iso img dmg
md mdx txt log lock diff patch key pem crt cert
http rest ipynb tf tfvars nix cmake mk dockerfile
tex sln csproj rake gemspec webmanifest babelrc npmrc nvmrc
`.trim().split(/\s+/);

/** Whole filenames the theme gives a dedicated glyph. */
const FILENAMES = `
package.json package-lock.json bun.lock bun.lockb yarn.lock pnpm-lock.yaml
tsconfig.json jsconfig.json bunfig.toml deno.json
.gitignore .gitattributes .gitmodules .gitkeep .mailmap
.npmrc .npmignore .nvmrc .yarnrc .editorconfig .browserslistrc
.prettierrc .prettierrc.json .prettierignore
.eslintrc .eslintrc.js .eslintrc.json eslint.config.js eslint.config.mjs
.env .env.local .env.development .env.production .env.example .env.test
Dockerfile dockerfile docker-compose.yml docker-compose.yaml compose.yaml .dockerignore
Makefile makefile CMakeLists.txt meson.build BUILD WORKSPACE Justfile
README.md readme.md LICENSE LICENSE.md COPYING CHANGELOG.md CONTRIBUTING.md
CODE_OF_CONDUCT.md SECURITY.md CODEOWNERS AUTHORS
vite.config.ts vite.config.js rollup.config.js webpack.config.js
tailwind.config.js tailwind.config.ts postcss.config.js postcss.config.mjs
babel.config.js .babelrc jest.config.js jest.config.ts vitest.config.ts
playwright.config.ts cypress.config.ts karma.conf.js nodemon.json pm2.config.js
next.config.js next.config.mjs nuxt.config.ts svelte.config.js astro.config.mjs
angular.json vue.config.js remix.config.js gatsby-config.js metro.config.js
go.mod go.sum go.work Cargo.toml Cargo.lock
requirements.txt pyproject.toml setup.py setup.cfg Pipfile Pipfile.lock poetry.lock
tox.ini pytest.ini manage.py
Gemfile Gemfile.lock Rakefile composer.json composer.lock
pom.xml build.gradle build.gradle.kts settings.gradle gradlew mix.exs
.gitlab-ci.yml .travis.yml appveyor.yml azure-pipelines.yml Jenkinsfile
netlify.toml vercel.json now.json firebase.json app.json fly.toml railway.json
serverless.yml Procfile Vagrantfile
manifest.json robots.txt sitemap.xml humans.txt .htaccess favicon.ico
index.html index.ts index.js main.ts main.go
CLAUDE.md AGENTS.md
`.trim().split(/\s+/);

/** Folder names the theme gives a dedicated glyph. */
const FOLDERS = `
src app apps packages lib dist build public assets images fonts
components hooks utils helpers shared config api server client services
store views controllers routes middleware
test tests __tests__ e2e coverage docs examples scripts bin
database db migrations types locales i18n functions
node_modules vendor .git .github .vscode .husky
android ios logs tmp temp cache
`.trim().split(/\s+/);

/** `file_type_typescript.svg` → `file-type-typescript` (the Iconify key). */
function iconifyKey(svgName: string | undefined): string | null {
  if (!svgName) return null;
  return svgName.replace(/\.svg$/, "").replace(/_/g, "-");
}

const collection = (await import("@iconify-json/vscode-icons/icons.json", {
  with: { type: "json" },
})).default as { icons: Record<string, { body: string }>; width?: number; height?: number };

/** Both drawings of one glyph; `light` only when the theme ships a second one. */
type Glyph = { dark: string; light?: string };

const used = new Map<string, Glyph>(); // iconify key → bodies
const missing = new Set<string>();
const overBudget = new Map<string, number>();
let lightVariants = 0;

/**
 * `file_type_light_json` → `file_type_json`.
 *
 * The mapping tables answer with the **light** name for 143 of these glyphs and
 * there is no option to ask for the other one — `getIconForFile("a.json")` is
 * `file_type_light_json` full stop. Those are the drawings vscode-icons uses
 * when the *workbench* theme is light: `#fbc02d` where the normal one is
 * `#f5de19`, and for `toml` a path with no `fill` at all, i.e. black. Shipping
 * them as the only artwork is how the JSON braces came out muddy and the TOML
 * glyph came out invisible on every dark PPM theme. So the class is named after
 * the theme-independent glyph and carries both drawings.
 */
function canonical(key: string): string {
  return key.replace(/^file-type-light-/, "file-type-");
}

function take(svgName: string | undefined): string | null {
  const named = iconifyKey(svgName);
  return named === null ? null : takeKey(named);
}

function takeKey(named: string): string | null {
  const aliased = ALIASES[named] ?? named;
  const key = canonical(aliased);
  if (used.has(key)) return key;
  const icon = collection.icons[key];
  if (!icon) {
    // A name the mapping knows and the collection does not: the two are
    // versioned separately, so this is reported rather than silently dropped.
    missing.add(key);
    return null;
  }
  if (icon.body.length > MAX_BODY_BYTES && !KEEP_ANY_SIZE.has(key)) {
    overBudget.set(key, icon.body.length);
    return null;
  }
  const light = collection.icons[key.replace(/^file-type-/, "file-type-light-")];
  // A light drawing over the budget is simply left out: the class still has its
  // dark one, which is legible on a light background, just not tuned for it.
  const within = light && light.body.length <= MAX_BODY_BYTES;
  if (within) lightVariants++;
  used.set(key, { dark: icon.body, light: within ? light.body : undefined });
  return key;
}

const DEFAULT_FILE = take("default_file.svg")!;
const DEFAULT_FOLDER = take("default_folder.svg")!;
const DEFAULT_FOLDER_OPEN = take("default_folder_opened.svg")!;

/** An override if there is one, else whatever the mapping tables answer. */
function iconFor(name: string, mapped: string | undefined): string | null {
  const override = OVERRIDES[name];
  return override ? takeKey(override) : take(mapped);
}

const extIcon: Record<string, string> = {};
for (const ext of [...Object.keys(FileExtensions2ToIcon), ...EXTENSIONS]) {
  const key = iconFor(ext, getIconForFile(`file.${ext}`));
  // Only worth an entry when it differs from the fallback the component uses.
  if (key && key !== DEFAULT_FILE) extIcon[ext] = key;
}

const nameIcon: Record<string, string> = {};
for (const name of FILENAMES) {
  const key = iconFor(name, getIconForFile(name));
  if (!key || key === DEFAULT_FILE) continue;
  // Skip a filename whose icon its own extension already gives: `main.go` and
  // `.go` resolve to the same glyph, and the extension table already covers it.
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext && extIcon[ext] === key) continue;
  nameIcon[name.toLowerCase()] = key;
}

const folderIcon: Record<string, string> = {};
const folderOpenIcon: Record<string, string> = {};
for (const folder of FOLDERS) {
  const closed = take(getIconForFolder(folder));
  const open = take(getIconForOpenFolder(folder));
  if (closed && closed !== DEFAULT_FOLDER) folderIcon[folder.toLowerCase()] = closed;
  if (open && open !== DEFAULT_FOLDER_OPEN) folderOpenIcon[folder.toLowerCase()] = open;
}

function record(map: Record<string, string>): string {
  return Object.keys(map)
    .sort()
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(map[k])},`)
    .join("\n");
}

const viewBox = `0 0 ${collection.width ?? 32} ${collection.height ?? 32}`;
const names = [...used.keys()].sort();

const ts = `/**
 * GENERATED by \`bun scripts/gen-file-icons.ts\` — do not edit.
 *
 * Which glyph of the vscode-icons theme (MIT, vscode-icons-team) a name gets.
 * The glyphs themselves are in \`src/web/styles/file-icons.generated.css\`, one
 * class each: 500 KB of full-colour SVG has no business in a JS bundle, and as
 * CSS the browser decodes each icon once however many rows use it — which is
 * also how VS Code draws its own file icon themes.
 */

/** Lowercased extension → icon class suffix. */
export const EXTENSION_ICONS: Record<string, string> = {
${record(extIcon)}
};

/** Lowercased whole filename → icon; checked before the extension. */
export const FILENAME_ICONS: Record<string, string> = {
${record(nameIcon)}
};

/** Lowercased folder name → icon. */
export const FOLDER_ICONS: Record<string, string> = {
${record(folderIcon)}
};

/** Lowercased folder name → icon, for an expanded folder. */
export const FOLDER_OPEN_ICONS: Record<string, string> = {
${record(folderOpenIcon)}
};

export const DEFAULT_FILE_ICON = ${JSON.stringify(DEFAULT_FILE)};
export const DEFAULT_FOLDER_ICON = ${JSON.stringify(DEFAULT_FOLDER)};
export const DEFAULT_FOLDER_OPEN_ICON = ${JSON.stringify(DEFAULT_FOLDER_OPEN)};

/** Every icon this module can name, for the test that pairs the two files. */
export const ICON_NAMES: readonly string[] = ${JSON.stringify(names)};
`;

/**
 * A data URL rather than a sprite: one \`background-image\` per class is what
 * lets the browser cache each decoded icon independently, and a sprite would
 * need a second table of offsets that has to stay in step with the first.
 *
 * Only \`#\` and \`"\` have to be escaped for a URL inside \`url("…")\` — encoding
 * the whole body would add about a third to the file for no benefit, since the
 * transfer is compressed anyway.
 */
function dataUrl(body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
  return `data:image/svg+xml,${svg.replace(/"/g, "'").replace(/#/g, "%23").replace(/\n/g, "")}`;
}

const css = `/**
 * GENERATED by \`bun scripts/gen-file-icons.ts\` — do not edit.
 *
 * The vscode-icons file icon theme (MIT, vscode-icons-team), one class per
 * glyph. Sizing and layout live with the component in \`file-icons.tsx\`; this
 * file is nothing but the artwork.
 *
 * The theme draws some glyphs twice, and the second drawing is for a light
 * workbench — so the bare class is the dark-theme artwork and \`:root.light\`
 * swaps in the other. \`apply-theme.ts\` puts one of those two classes on
 * \`<html>\`, and \`index.html\` starts at \`class="dark"\`, so there is no frame
 * with neither.
 */
${names
  .map((name) => `.vsi-${name} {\n  background-image: url("${dataUrl(used.get(name)!.dark)}");\n}`)
  .join("\n")}

${names
  .filter((name) => used.get(name)!.light)
  .map(
    (name) =>
      `:root.light .vsi-${name} {\n  background-image: url("${dataUrl(used.get(name)!.light!)}");\n}`,
  )
  .join("\n")}
`;

writeFileSync(OUT_TS, ts);
writeFileSync(OUT_CSS, css);

const bodyBytes = [...used.values()].reduce(
  (n, g) => n + g.dark.length + (g.light?.length ?? 0),
  0,
);
console.log(
  `file icons  ${used.size} glyphs (${lightVariants} with a light-theme drawing)  ` +
    `${Object.keys(extIcon).length} extensions  ` +
    `${Object.keys(nameIcon).length} filenames  ${Object.keys(folderIcon).length} folders`,
);
console.log(
  `            ${(Buffer.byteLength(ts) / 1024).toFixed(1)} KiB of mapping (JS)  ` +
    `${(Buffer.byteLength(css) / 1024).toFixed(1)} KiB of artwork (CSS)  ` +
    `${(bodyBytes / 1024).toFixed(1)} KiB raw path data`,
);
if (missing.size > 0) console.log(`            not in the collection: ${[...missing].join(", ")}`);
if (overBudget.size > 0) {
  const worst = [...overBudget.entries()].sort((a, b) => b[1] - a[1]);
  console.log(
    `            over the ${MAX_BODY_BYTES}-byte budget, so left out: ${overBudget.size} ` +
      `(worst: ${worst.slice(0, 4).map(([k, n]) => `${k} ${(n / 1024).toFixed(0)}K`).join(", ")})`,
  );
}
