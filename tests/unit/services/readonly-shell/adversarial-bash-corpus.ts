/**
 * Bash commands and the verdict the read-only check must give each, built against a throwaway
 * filesystem: a registered project with a repository, a second project with none, a fake home
 * holding credential stores, an install folder, and links from the project into the home.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { getPpmDir } from "../../../../src/services/ppm-dir.ts";
import type { ReadonlyShellContext } from "../../../../src/services/assistant/readonly-shell/readonly-path-check.ts";

export interface CorpusFixture {
  base: string;
  home: string;
  proj: string;
  /** A registered project that is not a repository. */
  proj2: string;
  install: string;
  outside: string;
  /** A file symlink from the project to a key; null where this host refused to create one. */
  linkFile: string | null;
  ctx: ReadonlyShellContext;
  cleanup(): void;
}

const isWindows = process.platform === "win32";

function touch(path: string, content = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function createCorpusFixture(): CorpusFixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ppm-ro-shell-")));
  const home = join(base, "home");
  const proj = join(base, "proj");
  const proj2 = join(base, "proj2");
  const install = join(base, "install");
  const outside = join(base, "outside", "f.txt");
  for (const f of [".ssh/id_rsa", ".aws/credentials", ".ppm/ppm.db", "notes/todo.md"]) touch(join(home, f));
  for (const f of ["src/a.ts", "a.json", "data.db", "log", "f"]) touch(join(proj, f));
  mkdirSync(join(proj, ".git"), { recursive: true });
  touch(join(proj2, "f"));
  touch(join(install, "src", "index.ts"));
  touch(outside);
  // A directory link needs no privilege on Windows as a junction.
  symlinkSync(join(home, ".ssh"), join(proj, "link-to-ssh"), isWindows ? "junction" : "dir");
  let linkFile: string | null = join(proj, "link-file");
  try {
    symlinkSync(join(home, ".ssh", "id_rsa"), linkFile, "file");
  } catch {
    linkFile = null; // Windows without Developer Mode refuses file symlinks.
  }
  mkdirSync(getPpmDir(), { recursive: true });
  return {
    base, home, proj, proj2, install, outside, linkFile,
    ctx: { projectRoots: [proj, proj2], home, env: {}, installRoot: install, cwd: proj },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export interface CorpusCase {
  command: string;
  expected: "readonly" | "ask";
  why: string;
  ctx?: Partial<ReadonlyShellContext>;
}

/** Single-quoted, so a Windows path's backslashes and drive colon reach the program as written. */
export const q = (p: string) => `'${p}'`;

export function adversarialBashCorpus(fx: CorpusFixture): CorpusCase[] {
  const P = q(fx.proj);
  const p = (rel: string) => q(join(fx.proj, rel));
  const ro = (command: string, why: string, ctx?: Partial<ReadonlyShellContext>): CorpusCase => ({ command, expected: "readonly", why, ctx });
  const no = (command: string, why: string, ctx?: Partial<ReadonlyShellContext>): CorpusCase => ({ command, expected: "ask", why, ctx });
  const linux = { platform: "linux" };
  const win = { platform: "win32" };
  const homeProject = { projectRoots: [fx.home] };

  const cases: CorpusCase[] = [
    // Reads that run unasked.
    ro("git status", "status of the project the shell starts in"),
    ro(`git -C ${P} log --oneline -20`, "log of a registered repository"),
    ro(`ls -la ${P}`, "listing a project"),
    ro(`grep -rn foo ${p("src")}`, "recursive search inside a project"),
    ro(`head -50 ${p("a.json")}`, "head of a project file"),
    ro("df -h", "disk usage, no paths"),
    ro("ps -eo pid,comm,rss", "process names and memory only", linux),
    ro(`sqlite3 -readonly ${p("data.db")} "select count(*) from t"`, "proven read of a project database"),
    ro("docker ps", "container list"),
    ro(`wc -l ${p("a.json")} | sort`, "a filter after a pipe"),
    ro(`cat ${p("src/a.ts")}`, "a project file"),
    ro("ls", "the project the shell starts in"),
    ro("git status --porcelain=v2 -b", "attached optional value"),
    ro(`git -C ${P} diff --stat HEAD~3`, "a mid-word tilde is literal"),
    ro("git log -n 5 --format='%h %s'", "a quoted format"),
    ro("git branch -a", "listing branches"),
    ro("git branch --list 'feat/x'", "a branch pattern with --list"),
    ro("git tag -l", "listing tags"),
    ro("git rev-parse --show-toplevel", "repository root"),
    ro(`git -C ${P} show HEAD:src/a.ts`, "a blob of the repository"),
    ro("git log --oneline HEAD~10..HEAD -- src", "a range and a pathspec"),
    ro("git blame -L 1,5 src/a.ts", "blame of a tracked file"),
    ro(`rg -n TODO ${p("src")}`, "ripgrep inside a project"),
    ro(`rg --files ${P}`, "ripgrep listing files"),
    ro(`find ${P} -name '*.ts' -maxdepth 3 -type f`, "find with tests only"),
    ro(`du -sh ${P}`, "size of a project"),
    ro(`tail -n 20 ${p("log")} 2>/dev/null`, "stderr discarded"),
    ro(`cat ${p("a.json")} | head -5 | wc -c`, "two filters"),
    ro("uname -a && uptime && free -h", "system facts joined by &&"),
    ro("echo hello; date +%Y-%m-%d", "echo and a date format"),
    ro(`stat -c %s ${p("a.json")}`, "file size"),
    ro(`ls -la ${q(join(fx.install, "src"))}`, "PPM's install folder is a read root"),
    ro(`sort -u ${p("log")} | uniq -c | sort -rn | head`, "a filter chain"),
    ro(`grep -c foo ${p("log")} >/dev/null 2>&1`, "output discarded"),
    ro(`cut -d, -f1 ${p("log")} | tr a-z A-Z`, "cut and tr"),
    ro("which git", "where a program lives"),
    ro("nproc && hostname && whoami", "machine facts"),
    ro("docker images -q", "image ids"),
    ro("docker stats --no-stream", "one sample of container stats"),
    ro("ps -A -o pid,%cpu,%mem --sort=-%mem", "sorted process columns", linux),
    ro(`file ${p("a.json")}`, "file type"),
    ro(`ls ${q(fx.home)}`, "listing names of a home registered as a project", homeProject),
    ro(`cat ${q(join(fx.home, "notes", "todo.md"))}`, "an ordinary file in a home project", homeProject),
    ro(`ls ${P} 2>&1 | grep src`, "stderr joined then filtered"),

    // The adversarial cases: each must ask.
    no("cat ~/.ssh/id_rsa", "a key under the home folder"),
    no(`cat ${q(`${fx.proj}${sep}..${sep}home${sep}.ssh${sep}id_rsa`)}`, "`..` leaves the project"),
    no(`cat ${q(join(fx.proj, "link-to-ssh", "id_rsa"))}`, "a link out of the project"),
    no(`ls ${q(join(fx.proj, "link-to-ssh"))}`, "listing through a link"),
    no('cat "$HOME/.aws/credentials"', "a variable"),
    no("cat ~root/x", "another user's home"),
    no(`cat ${P}/*`, "a glob"),
    no(`ls; rm -rf ${P}`, "a write after ;"),
    no("ls && curl x", "network after &&"),
    no("ls | sh", "a shell after a pipe"),
    no("ls | xargs rm", "xargs after a pipe"),
    no("git -c core.pager=sh log", "config naming a program"),
    no("git log --output=/tmp/x", "git writes a file"),
    no("git diff --ext-diff", "an external diff program"),
    no(`find ${P} -delete`, "find deletes"),
    no(`find ${P} -exec rm {} ;`, "find runs a program"),
    no(`find ${P} -exec rm '{}' ';'`, "find runs a program, quoted"),
    no(`rg --pre ./x pat ${P}`, "ripgrep runs a preprocessor"),
    no(`sort -o ${p("f")} ${p("f")}`, "sort writes a file"),
    no(`tail -f ${p("log")}`, "never ends"),
    no(`sqlite3 ${p("a.db")} ".shell id"`, "a dot-command without -readonly"),
    no(`sqlite3 -readonly ${p("a.db")} "select writefile('x','y')"`, "a file-writing function"),
    no('sqlite3 -readonly ~/.ppm/ppm.db "select 1"', "a database under the home folder"),
    no(`sqlite3 -readonly ${q(join(getPpmDir(), "ppm.db"))} "select 1"`, "PPM's own database", { projectRoots: [dirname(getPpmDir())] }),
    no(`echo x > ${p("f")}`, "a redirection to a file"),
    no("cat < ~/.ssh/id_rsa", "an input redirection"),
    no("echo `id`", "a backtick substitution"),
    no("echo $(id)", "a command substitution"),
    no("FOO=1 ls", "an assignment prefix"),
    no(`/bin/cat ${p("f")}`, "a program named by path"),
    no("./cat", "a program in the working directory"),
    no(`cat ${p("f")} # comment`, "a comment"),
    no("cat 'proj/f'\\''x'", "an escaped quote"),
    no("ps aux", "BSD options show command lines"),
    no("ps -eo args", "command lines", linux),
    no("docker inspect x", "inspect shows environment"),
    no("git remote -v", "remote URLs can hold tokens"),
    no("cat C:\\Users\\PC\\PPM~1\\ppm.db", "backslashes outside quotes"),
    no("cat 'C:\\Users\\PC\\PPM~1\\ppm.db'", "an 8.3 short name", win),
    no("cat C:\\x\\f.txt:secret", "backslashes outside quotes"),
    no(`cat ${q(`${join(fx.proj, "a.json")}:secret`)}`, "an NTFS stream", win),
    no("cat \\\\server\\share\\f", "a UNC path"),
    no("cat '//server/share/f'", "a UNC path, quoted", win),
    no(`du -L ${P}`, "du follows links"),
    no(`grep -R x ${P}`, "grep follows links"),
    no("ls\nrm x", "a newline"),

    // More ways out.
    no(`cat ${p("a.json")} | cat`, "cat is not a pipe filter"),
    no(`cat ${q(fx.outside)}`, "outside every read root"),
    no("cat a.json", "a relative path"),
    no("ls ..", "a relative parent"),
    no("git status", "no known working directory", { cwd: undefined }),
    no("ls", "the working directory is outside every project", { cwd: fx.base }),
    no(`git -C ${q(fx.proj2)} log`, "git would search above the project"),
    no(`git -C ${q(fx.home)} log`, "the home folder is not a project"),
    no(`rg -L foo ${P}`, "ripgrep follows links"),
    no(`rg --follow foo ${P}`, "ripgrep follows links"),
    no(`rg -z foo ${P}`, "ripgrep runs decompressors"),
    no(`rg foo ${P}`, "a ripgrep config can add options", { env: { RIPGREP_CONFIG_PATH: "/x" } }),
    no(`find -L ${P} -name x`, "find follows links"),
    no(`find ${P} -fprint ${p("out")}`, "find writes a file"),
    no(`sudo cat ${p("f")}`, "sudo"),
    no(`env cat ${p("f")}`, "env runs what follows"),
    no("bash -c 'ls'", "a nested shell"),
    no(`timeout 5 cat ${p("f")}`, "timeout runs what follows"),
    no(`cat ${p("f")} &`, "background"),
    no(`cat ${p("f")} & ls`, "background then more"),
    no(`ls ${P} 2>${p("err")}`, "stderr to a file"),
    no(`ls ${P} >>/dev/null`, "an append redirection"),
    no(`cat ${p("f")} | tee ${p("g")}`, "tee writes"),
    no("ls x=~/y", "a tilde after = expands in bash"),
    no("cat '~'/.ssh/id_rsa", "a quoted tilde is relative"),
    no("head -n 5 <(cat x)", "process substitution"),
    no("cat {a,b}", "brace expansion"),
    no(`grep -f ${q(join(fx.home, ".ssh", "id_rsa"))} ${P}`, "grep reads patterns from a file"),
    no(`uniq ${p("log")} ${p("g")}`, "uniq writes its second argument"),
    no(`sort --compress-program=sh ${p("f")}`, "sort runs a compressor"),
    no("hostname evil", "sets the host name"),
    no("date -s 2020-01-01", "sets the clock"),
    no("date 010100002020", "sets the clock"),
    no(`tail --follow=name ${p("log")}`, "never ends"),
    no("git branch newbranch", "creates a branch"),
    no("git tag v9", "creates a tag"),
    no(`git diff ${p("a.json")} ~/.ssh/id_rsa`, "a path outside the repository turns diff into --no-index"),
    no("git diff -- ../outside", "a pathspec above the repository"),
    no(`git diff --no-index ${p("a.json")} ${p("f")}`, "--no-index"),
    no("git --git-dir=/x log", "another repository"),
    no(`git -C ${P} -C src log`, "a second -C"),
    no("git status", "GIT_DIR points elsewhere", { env: { GIT_DIR: "/x" } }),
    no("docker ps --format '{{.Command}}'", "a format can print commands"),
    no("docker stats", "never ends"),
    no("ps -o pid,args", "command lines"),
    no("ps -o pid=,cmd", "command lines"),
    no("ps", "default columns"),
    no("ps -eo pid,comm", "-e adds the environment on macOS", { platform: "darwin" }),
    no(`ls ${P};`, "an empty segment"),
    no(`ls ${P}\\`, "a trailing backslash"),
    no(`ls ${P} !`, "history expansion"),
    no(`cat ${q(join(fx.proj, ".."))}`, "the folder above the project"),
    no(`grep -r foo ${q(fx.home)}`, "a search that walks credential stores", homeProject),
    no(`cat ${q(join(fx.home, ".ssh", "id_rsa"))}`, "a key inside a home project", homeProject),
    no(`sqlite3 -readonly ${p("data.db")} "select 1; select 2"`, "two statements"),
    no(`sqlite3 -readonly ${p("data.db")} "delete from t"`, "a write"),
    no(`sqlite3 -readonly ${p("data.db")} "select 1" -cmd ".shell id"`, "-cmd runs a dot-command"),
    no(`sqlite3 -readonly -init ${p("x")} ${p("data.db")} "select 1"`, "-init reads a script"),
    no(`sqlite3 -readonly ${p("data.db")} "select load_extension('x')"`, "loads code"),
    no(`sqlite3 -readonly ${p("data.db")} "attach '/tmp/x' as y"`, "attach is not a read"),
    no(`sqlite3 -readonly ${p("data.db")} ".tables"`, "a dot-command"),
    no(`cat ${p("f")} ${p("link-to-ssh/id_rsa")}`, "one bad path among good ones"),
    no(`head -c 100 ${p("a.json")} | cat`, "cat after a pipe"),
    no("ls ''", "an empty argument is a relative path"),
    no(`ls ' ${fx.proj}'`, "leading whitespace in a path"),
    no("'ls'", "a quoted program name"),
    no("-ls", "a program name starting with a dash"),
    no(`grep -r foo ${q(join(fx.install))}`, "the install folder is not a read root without being passed", { installRoot: null }),
  ];
  if (fx.linkFile) cases.push(no(`cat ${q(fx.linkFile)}`, "a file symlink to a key"));
  return cases;
}
