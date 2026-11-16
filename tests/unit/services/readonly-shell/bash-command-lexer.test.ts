/**
 * The read-only check's bash lexer: what it accepts it can describe exactly, and everything else
 * comes back null so the command asks.
 */
import { describe, expect, it } from "bun:test";
import { ALLOWED_REDIRECTS, lexBash, type BashToken } from "../../../../src/services/assistant/readonly-shell/bash-command-lexer.ts";

const words = (tokens: BashToken[] | null) => tokens?.filter((t) => t.kind === "word").map((t) => t.value) ?? null;

describe("accepted text", () => {
  it("splits words, quotes and operators", () => {
    expect(lexBash("ls -la /x && git log --format='%h %s' | head -5; df -h || true")).toEqual([
      { kind: "word", value: "ls", quoted: false },
      { kind: "word", value: "-la", quoted: false },
      { kind: "word", value: "/x", quoted: false },
      { kind: "op", value: "&&" },
      { kind: "word", value: "git", quoted: false },
      { kind: "word", value: "log", quoted: false },
      { kind: "word", value: "--format=%h %s", quoted: true },
      { kind: "op", value: "|" },
      { kind: "word", value: "head", quoted: false },
      { kind: "word", value: "-5", quoted: false },
      { kind: "op", value: ";" },
      { kind: "word", value: "df", quoted: false },
      { kind: "word", value: "-h", quoted: false },
      { kind: "op", value: "||" },
      { kind: "word", value: "true", quoted: false },
    ]);
  });

  it("joins adjacent quoted and bare parts into one word, as bash does", () => {
    expect(words(lexBash(`echo a'b c'"d e"f`))).toEqual(["echo", "ab cd ef"]);
    expect(words(lexBash(`echo '' ""`))).toEqual(["echo", "", ""]);
  });

  it("keeps anything inside single quotes literally, and double quotes without expansion characters", () => {
    expect(words(lexBash(`grep '$HOME * ? [x] {a,b} \\ ! #' "a*b?#"`))).toEqual(["grep", "$HOME * ? [x] {a,b} \\ ! #", "a*b?#"]);
  });

  it("accepts the four redirections only as whole tokens", () => {
    for (const r of ALLOWED_REDIRECTS) {
      expect(lexBash(`ls ${r}`)).toEqual([{ kind: "word", value: "ls", quoted: false }, { kind: "redirect", value: r }]);
    }
    expect(lexBash("ls 2>/dev/null&&df")?.map((t) => t.kind)).toEqual(["word", "redirect", "op", "word"]);
  });

  it("accepts a home tilde at a word's start and a literal one inside a word", () => {
    expect(words(lexBash("cat ~ ~/x"))).toEqual(["cat", "~", "~/x"]);
    expect(words(lexBash("git log HEAD~3 a~b~~"))).toEqual(["git", "log", "HEAD~3", "a~b~~"]);
  });

  it("reads operators without surrounding blanks", () => {
    expect(lexBash("ls|head")?.map((t) => t.kind)).toEqual(["word", "op", "word"]);
  });
});

describe("rejected text", () => {
  const rejected = [
    "echo $HOME", "echo ${HOME}", "echo $(id)", "echo `id`", "echo $'x'", 'echo "$HOME"', 'echo "a`id`"', 'echo "a\\b"', 'echo "hi!"',
    "echo a\\ b", "ls \\\n -la", "ls\nrm x", "ls\rx", "ls\0", "ls &", "ls & df", "ls |& head", "ls ;; df", "(ls)", "{ ls; }", "ls *", "ls ?",
    "ls [ab]", "ls # c", "!ls", "ls > f", "ls >f", "ls >> /dev/null", "ls < f", "cat <<EOF", "cat <<< x", "cat <(ls)", "ls >(cat)",
    "ls 2> /dev/null", "ls 2>/dev/nullx", "ls 1>/dev/null", "ls >/dev/null&", "ls ~root", "ls ~+", "ls ~-", "ls ~x/y", "ls a=~/x",
    "ls a:~/x", "ls '~'/x", 'ls "~/x"', "ls ~'/x'", "ls 'unterminated", 'ls "unterminated', "ls ^x", "ls é", "", "  ", "; ls", "ls ;",
    "ls && ", "| ls", "ls || || df", "ls\t\t;\t", "ls 'a\nb'",
  ];
  for (const text of rejected) {
    it(`rejects ${JSON.stringify(text)}`, () => expect(lexBash(text)).toBeNull());
  }
});

/**
 * Whether, outside single quotes and the exact redirections, `text` holds a character the
 * grammar must never let through. Written independently of the lexer's state machine.
 */
function leaksForbidden(text: string): boolean {
  let outside = "";
  let quote: "'" | '"' | null = null;
  for (const c of text) {
    if (quote === null && (c === "'" || c === '"')) quote = c;
    else if (c === quote) quote = null;
    else if (quote === '"' && /[$`\\!]/.test(c)) return true;
    else if (quote === null) outside += c;
  }
  if (quote !== null) return true;
  for (const r of ALLOWED_REDIRECTS) outside = outside.split(r).join(" ");
  outside = outside.replace(/&&|\|\|/g, " ");
  return /[$`\\!\n\r(){}*?[\]#<>&^]/.test(outside);
}

describe("property: an accepted command never carries an expansion character outside single quotes", () => {
  const alphabet = ["a", "b", "/", "-", ".", "~", "=", ":", " ", "'", '"', "$", "`", "\\", "!", "\n", "(", ")", "{", "}", "*", "?", "[", "]", "#",
    "<", ">", "&", "|", ";", "^", "2>/dev/null", "2>&1", ">/dev/null", "&>/dev/null", "ls ", " && ", " | "];
  // A fixed-seed generator keeps a failure reproducible.
  let seed = 0x5eed;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  it("holds over random strings", () => {
    let accepted = 0;
    for (let n = 0; n < 20000; n++) {
      let text = "";
      const len = 1 + rand(12);
      for (let i = 0; i < len; i++) text += alphabet[rand(alphabet.length)];
      const tokens = lexBash(text);
      if (!tokens) continue;
      accepted++;
      if (leaksForbidden(text)) throw new Error(`accepted ${JSON.stringify(text)}`);
      // Every word value reaches a program verbatim; none may carry a control character.
      for (const t of tokens) if (t.kind === "word") expect(/[\n\r\0]/.test(t.value)).toBe(false);
    }
    expect(accepted).toBeGreaterThan(500);
  });
});
