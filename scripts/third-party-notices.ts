/**
 * The one place `THIRD-PARTY-NOTICES.md` is written, and the reason it is not
 * written by hand.
 *
 * PPM ships other people's artwork: 14 subset `.woff2` faces cut from Nerd
 * Fonts, the vscode-icons drawings inlined as data URIs in a stylesheet, and
 * the Fluent System Icons path data compiled into a module. All three arrive
 * through a generator, none of them is recognisable as a third-party asset
 * once it has, and `package.json` has no `files` field — so everything in the
 * tree is in the tarball whether or not anybody remembered to say where it
 * came from. A notice written by hand goes stale the first time a generator's
 * source list is edited; one emitted by the generator cannot.
 *
 * Each generator owns its own section and rewrites only that section, because
 * they run independently: `bun scripts/gen-file-icons.ts` on its own must not
 * blank the font's notice. That is what the BEGIN/END markers are for.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Notice {
  /** The component, named the way its own project names it. */
  name: string;
  /** Where it came from, as a URL somebody can check. */
  upstream: string;
  /**
   * An SPDX identifier where one exists, spelled out where it does not.
   *
   * Nerd Fonts' own source table records Font Logos as "unlicensed"; upstream
   * it carries a verbatim copy of The Unlicense, which is a dedication to the
   * public domain rather than an absence of terms. GitHub's licence API
   * reports `Unlicense` for that repository, and the two readings are exact
   * opposites, so this column follows the licence text rather than the table.
   */
  license: string;
  /** The version vendored, where the source pins one. */
  version?: string;
  /**
   * The upstream copyright line, without the sign.
   *
   * A column rather than prose because MIT, Apache-2.0 and the OFL all require
   * the notice to travel with the work, and a table is the only shape that
   * makes a missing one visible.
   */
  holder: string;
  /** Anything a reader needs that the three columns cannot carry. */
  note?: string;
}

const FILE = resolve(import.meta.dir, "../THIRD-PARTY-NOTICES.md");

/**
 * The order the file lists sections in, so that the result does not depend on
 * which generator happened to run last.
 */
const SECTIONS = ["product-icons", "file-icons", "nerd-font"] as const;
export type SectionId = (typeof SECTIONS)[number];

const HEADER = `# Third-party notices

PPM itself is licensed under the Elastic License 2.0 (see \`LICENSE\`). It also
redistributes the components below, each under its own terms, which continue to
apply to those components.

Every section here is emitted by the generator that vendors the component —
edit that generator, not this file. Re-run:

\`\`\`
bun scripts/gen-product-icons.ts
bun scripts/gen-file-icons.ts
bun scripts/gen-nerd-font.ts
\`\`\`
`;

function begin(id: SectionId): string {
  return `<!-- BEGIN ${id} -->`;
}
function end(id: SectionId): string {
  return `<!-- END ${id} -->`;
}

/** `github.com/owner/repo` reads better in a table cell than the whole URL. */
function short(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname.replace(/\/$/, "")}`;
}

function renderTable(notices: readonly Notice[]): string {
  const rows = notices.map(
    (n) =>
      `| ${n.name} | [${short(n.upstream)}](${n.upstream}) | ${n.version ?? "—"} | ${licenseCell(n.license)} | \u00a9 ${n.holder} |`,
  );
  const notes = notices.filter((n) => n.note).map((n) => `- **${n.name}** — ${n.note}`);
  return [
    "| Component | Upstream | Version | Licence | Copyright |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    ...(notes.length > 0 ? ["", ...notes] : []),
  ].join("\n");
}

/**
 * Every SPDX id in the column links to the text committed under `licenses/`.
 *
 * A link to spdx.org would not do: MIT, Apache-2.0 and the OFL each require the
 * licence itself to be distributed with the work, so the copy has to be in the
 * tarball. The cell may name two (Font Awesome licenses its icons and its fonts
 * differently), so this rewrites ids wherever they appear rather than treating
 * the whole cell as one.
 */
function licenseCell(license: string): string {
  return license.replace(/[A-Za-z0-9.-]+/g, (word) =>
    VENDORED.has(word) ? `[${word}](licenses/${word}.txt)` : word,
  );
}

/** The texts committed under `licenses/`. */
const VENDORED = new Set(["MIT", "Apache-2.0", "OFL-1.1", "CC-BY-4.0", "Unlicense"]);

/**
 * Replace one section of the notices file, leaving the others as they are.
 *
 * `intro` is prose the generator wants above its table — what was vendored and
 * in what form, which is the part a licence column cannot say.
 */
export function writeNotices(
  id: SectionId,
  heading: string,
  intro: string,
  notices: readonly Notice[],
): void {
  const body = [
    begin(id),
    "",
    `## ${heading}`,
    "",
    intro.trim(),
    "",
    renderTable(notices),
    "",
    end(id),
  ].join("\n");

  const existing = existsSync(FILE) ? readFileSync(FILE, "utf-8") : "";
  const sections = new Map<SectionId, string>();
  for (const other of SECTIONS) {
    if (other === id) continue;
    const from = existing.indexOf(begin(other));
    const to = existing.indexOf(end(other));
    if (from !== -1 && to > from) sections.set(other, existing.slice(from, to + end(other).length));
  }
  sections.set(id, body);

  const out =
    [HEADER.trim(), ...SECTIONS.filter((s) => sections.has(s)).map((s) => sections.get(s)!)].join(
      "\n\n",
    ) + "\n";
  writeFileSync(FILE, out);
  console.log(`notices    ${id}: ${notices.length} component${notices.length === 1 ? "" : "s"}`);
}
