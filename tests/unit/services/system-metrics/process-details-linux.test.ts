import { describe, test, expect } from "bun:test";
import {
  readProcessDetails, parseStatFields, parseBootTimeSec, parseUid,
  lookupUser, parseCgroup, describeState,
} from "../../../../src/services/system-metrics/process-details-linux.ts";
import { redactSecrets } from "../../../../src/services/redact-secrets.ts";
import type { LinuxFs } from "../../../../src/services/system-metrics/linux-fs.ts";

const fsOf = (files: Record<string, string>, links: Record<string, string> = {}): LinuxFs => ({
  read: (p: string) => files[p] ?? null,
  list: () => null,
  readlink: (p: string) => links[p] ?? null,
  realpath: (p: string) => links[p] ?? p,
  exists: (p: string) => p in files || p in links,
});

// state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt
// utime stime cutime cstime priority nice threads itrealvalue starttime
const STAT = "100 (vim) S 1 100 100 0 -1 4194304 500 0 0 0 12 34 0 0 20 -5 8 0 4242";
const BOOT = "cpu  1 2 3\nbtime 1700000000\nprocesses 9\n";

const host = (over: Record<string, string> = {}) => fsOf({
  "/proc/stat": BOOT,
  "/proc/100/stat": STAT,
  "/proc/100/status": "Name:\tvim\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\n",
  "/proc/100/cmdline": "vim\0-p\0notes.md\0",
  "/proc/100/cgroup": "0::/user.slice/user-1000.slice/app.slice/vim.scope\n",
  "/etc/passwd": "root:x:0:0:root:/root:/bin/bash\nthawngho:x:1000:1000::/home/thawngho:/bin/zsh\n",
  ...over,
}, { "/proc/100/exe": "/usr/bin/vim", "/proc/100/cwd": "/home/thawngho/notes" });

describe("parseStatFields", () => {
  test("reads state, ppid, nice, threads and start ticks by position", () => {
    expect(parseStatFields(STAT)).toEqual({
      comm: "vim", state: "S", ppid: 1, nice: -5, threads: 8, startTicks: 4242,
    });
  });

  test("a comm containing ') (' does not shift a single field", () => {
    const evil = "100 (evil) 9 (hack) S 1 100 100 0 -1 4194304 500 0 0 0 12 34 0 0 20 -5 8 0 4242";
    const f = parseStatFields(evil);
    expect(f?.comm).toBe("evil) 9 (hack");
    expect(f?.ppid).toBe(1);
    expect(f?.startTicks).toBe(4242);
  });

  test("a truncated or malformed line is null, never a row of NaN", () => {
    expect(parseStatFields("")).toBeNull();
    expect(parseStatFields("100 (vim")).toBeNull();
    expect(parseStatFields("100 (vim) S")).toBeNull();
  });
});

describe("the small parsers", () => {
  test("btime is seconds since epoch", () => {
    expect(parseBootTimeSec(BOOT)).toBe(1700000000);
    expect(parseBootTimeSec("cpu 1 2 3\n")).toBeNull();
    expect(parseBootTimeSec(null)).toBeNull();
  });

  test("Uid takes the REAL uid, the first of the four", () => {
    expect(parseUid("Uid:\t1000\t0\t0\t0\n")).toBe(1000);
    expect(parseUid("Name:\tvim\n")).toBeNull();
  });

  test("uid resolves through /etc/passwd, which is world-readable", () => {
    const passwd = "root:x:0:0::/root:/bin/sh\nthawngho:x:1000:1000::/home/t:/bin/zsh\n";
    expect(lookupUser(1000, passwd)).toBe("thawngho");
    expect(lookupUser(0, passwd)).toBe("root");
    expect(lookupUser(65534, passwd)).toBeNull();
    expect(lookupUser(0, null)).toBeNull();
  });

  test("cgroup v2's single 0:: line, and v1's systemd hierarchy", () => {
    expect(parseCgroup("0::/user.slice/app.slice/code.scope\n")).toBe("/user.slice/app.slice/code.scope");
    expect(parseCgroup("8:cpu:/other\n1:name=systemd:/user.slice/vim.scope\n"))
      .toBe("/user.slice/vim.scope");
    expect(parseCgroup("8:cpu,cpuacct:/first\n")).toBe("/first");
    expect(parseCgroup("")).toBeNull();
    expect(parseCgroup(null)).toBeNull();
  });

  test("the kernel's one letter is spelled out, and an unknown one is passed through", () => {
    expect(describeState("R")).toBe("R (Running)");
    expect(describeState("Z")).toBe("Z (Zombie)");
    expect(describeState("Q")).toBe("Q");
    expect(describeState("")).toBeNull();
  });
});

describe("readProcessDetails", () => {
  test("a process this user owns fills every field", () => {
    expect(readProcessDetails(100, { fs: host() })).toEqual({
      pid: 100,
      ppid: 1,
      name: "vim",
      startedAt: 1700000042420,
      command: "vim -p notes.md",
      exe: "/usr/bin/vim",
      cwd: "/home/thawngho/notes",
      user: "thawngho",
      state: "S (Sleeping)",
      threads: 8,
      nice: -5,
      cgroup: "/user.slice/user-1000.slice/app.slice/vim.scope",
    });
  });

  test("a pid that is gone is null — the dialog says so rather than showing zeros", () => {
    expect(readProcessDetails(999, { fs: host() })).toBeNull();
  });

  test("a pid that is not a pid never reaches the filesystem", () => {
    let reads = 0;
    const fs = { ...host(), read: (p: string) => { reads++; return host().read(p); } };
    expect(readProcessDetails(0, { fs })).toBeNull();
    expect(readProcessDetails(-1, { fs })).toBeNull();
    expect(readProcessDetails(1.5, { fs })).toBeNull();
    expect(reads).toBe(0);
  });

  test("another user's exe and cwd are EACCES, which is null and not an error", () => {
    const d = readProcessDetails(100, { fs: fsOf({
      "/proc/stat": BOOT,
      "/proc/100/stat": STAT,
      "/proc/100/status": "Name:\tvim\nUid:\t0\t0\t0\t0\n",
      "/proc/100/cmdline": "vim\0",
      "/etc/passwd": "root:x:0:0::/root:/bin/sh\n",
    }) });
    expect(d?.exe).toBeNull();
    expect(d?.cwd).toBeNull();
    expect(d?.cgroup).toBeNull();
    expect(d?.user).toBe("root");
  });

  test("a kernel thread has NO command line, which is null and not an empty string", () => {
    const d = readProcessDetails(100, { fs: host({ "/proc/100/cmdline": "" }) });
    expect(d?.command).toBeNull();
    expect(d?.name).toBe("vim");
  });

  test("argv is joined on its NULs, so an argument with a space stays one argument", () => {
    const d = readProcessDetails(100, { fs: host({ "/proc/100/cmdline": "git\0commit\0-m\0two words\0" }) });
    expect(d?.command).toBe("git commit -m two words");
  });

  test("the command is redacted with the shared redactor and NOT truncated to a row's 160", () => {
    const long = `node server.js ${"--flag=x ".repeat(40)}`.trim();
    const d = readProcessDetails(100, { fs: host({ "/proc/100/cmdline": long.split(" ").join("\0") }) });
    expect(d?.command).toBe(redactSecrets(long));
    expect(d!.command!.length).toBeGreaterThan(160);
  });

  test("/etc/passwd is read once per request, not once per line", () => {
    let passwdReads = 0;
    readProcessDetails(100, { fs: host(), passwd: () => { passwdReads++; return "thawngho:x:1000:1000::/h:/bin/zsh"; } });
    expect(passwdReads).toBe(1);
  });

  test("an unreadable /proc/stat costs the start time and nothing else", () => {
    const files = host();
    const d = readProcessDetails(100, { fs: { ...files, read: (p: string) => (p === "/proc/stat" ? null : files.read(p)) } });
    expect(d?.startedAt).toBe(0);
    expect(d?.name).toBe("vim");
  });

  test("status's Name is preferred over the parenthesised comm, without unwrapping", () => {
    const d = readProcessDetails(100, { fs: host({ "/proc/100/status": "Name:\tnvim\nUid:\t1000\t1000\t1000\t1000\n" }) });
    expect(d?.name).toBe("nvim");
  });
});
