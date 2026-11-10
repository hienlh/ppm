/**
 * Reads a test run's output and says what happened, for Thorough mode's red/green gates.
 *
 * The question is not just "did it exit non-zero" but "did the tests *run* and fail" — a red
 * that comes from a missing module, a syntax error or a test file that never loaded proves
 * nothing about the behaviour, so it is `broken`, not `fail`. A test that throws (calling a
 * stub that says "not implemented") did run, and counts as a real red.
 *
 * Each runner's default reporter is recognised by the command and by its own output; an
 * unknown runner is judged by its exit code alone and marked `weak`, which the UI says.
 */

export type RunnerName = "bun" | "vitest" | "jest" | "pytest" | "go" | "cargo" | "generic";

export interface RunInput {
  command: string;
  output: string;
  /** Exit code; null when the process could not start or was killed. */
  code: number | null;
  timedOut: boolean;
}

export interface Verdict {
  runner: RunnerName;
  /** pass: tests ran, none failed · fail: tests ran, some failed · broken: tests did not load or
   *  compile · empty: no test ran · timeout: killed by the time limit. */
  outcome: "pass" | "fail" | "broken" | "empty" | "timeout";
  failing: string[];
  passed: number | null;
  failed: number | null;
  /** The verdict rests on the exit code only. */
  weak: boolean;
  reason: string;
}

const num = (m: RegExpMatchArray | null, i = 1): number | null => (m ? Number(m[i]) : null);
const uniq = (xs: string[]): string[] => [...new Set(xs)];

function detect(command: string, output: string): RunnerName {
  const c = command.toLowerCase();
  if (/\bbun\s+(run\s+)?test\b/.test(c) || /^bun test v\d/m.test(output)) return "bun";
  if (/\bvitest\b/.test(c) || /^\s*RUN\s+v\d.*\n|Test Files\s+\d/m.test(output)) return "vitest";
  if (/\bjest\b/.test(c) || /^Test Suites:\s/m.test(output)) return "jest";
  if (/\bpytest\b/.test(c) || /=+ test session starts =+/.test(output)) return "pytest";
  if (/\bgo\s+test\b/.test(c)) return "go";
  if (/\bcargo\s+(\+\S+\s+)?(test|nextest)\b/.test(c) || /^test result: (ok|FAILED)\./m.test(output)) return "cargo";
  return "generic";
}

function verdict(runner: RunnerName, outcome: Verdict["outcome"], reason: string, extra: Partial<Verdict> = {}): Verdict {
  return { runner, outcome, failing: [], passed: null, failed: null, weak: false, reason, ...extra };
}

function judgeBun(o: string, code: number | null): Verdict {
  const passed = num(o.match(/^\s*(\d+) pass\s*$/m));
  const failed = num(o.match(/^\s*(\d+) fail\s*$/m));
  const errors = num(o.match(/^\s*(\d+) errors?\s*$/m)) ?? 0;
  const ran = num(o.match(/^Ran (\d+) tests?/m));
  const failing = uniq([...o.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/gm)].map((m) => m[1]!));
  if (errors > 0 || /^# Unhandled error between tests/m.test(o)) {
    return verdict("bun", "broken", "a test file failed to load (see the error between tests)", { passed, failed, failing });
  }
  if (ran === 0 || (passed === 0 && failed === 0)) return verdict("bun", "empty", "no test ran", { passed, failed });
  if ((failed ?? 0) > 0) return verdict("bun", "fail", `${failed} failing`, { passed, failed, failing });
  if (code === 0) return verdict("bun", "pass", `${passed} passing`, { passed, failed });
  return verdict("bun", "broken", `exited ${code} with no failing test`, { passed, failed });
}

function judgeVitest(o: string, code: number | null): Verdict {
  const tests = o.match(/^\s*Tests\s+(.+)$/m)?.[1] ?? "";
  const failed = num(tests.match(/(\d+) failed/));
  const passed = num(tests.match(/(\d+) passed/));
  const failing = uniq([...o.matchAll(/^\s*FAIL\s+(\S.*?\s>\s.+?)\s*$/gm)].map((m) => m[1]!));
  if (/Failed Suites \d|Failed to load|Error: Transform failed|SyntaxError/.test(o) && !(failed && failed > 0)) {
    return verdict("vitest", "broken", "a test file failed to load", { passed, failed });
  }
  if (/no tests/i.test(tests) || (!failed && !passed)) return verdict("vitest", "empty", "no test ran");
  if (failed) return verdict("vitest", "fail", `${failed} failing`, { passed, failed, failing });
  return code === 0 ? verdict("vitest", "pass", `${passed} passing`, { passed, failed }) : verdict("vitest", "broken", `exited ${code}`);
}

function judgeJest(o: string, code: number | null): Verdict {
  const tests = o.match(/^Tests:\s+(.+)$/m)?.[1] ?? "";
  const failed = num(tests.match(/(\d+) failed/));
  const passed = num(tests.match(/(\d+) passed/));
  const failing = uniq([...o.matchAll(/^\s*● (.+?)\s*$/gm)].map((m) => m[1]!).filter((n) => !/Test suite failed to run/.test(n)));
  if (/● Test suite failed to run/.test(o) && !(failed && failed > 0)) return verdict("jest", "broken", "a test suite failed to run", { passed, failed });
  if (!failed && !passed) return verdict("jest", "empty", "no test ran");
  if (failed) return verdict("jest", "fail", `${failed} failing`, { passed, failed, failing });
  return code === 0 ? verdict("jest", "pass", `${passed} passing`, { passed, failed }) : verdict("jest", "broken", `exited ${code}`);
}

function judgePytest(o: string, code: number | null): Verdict {
  const summary = [...o.matchAll(/^=+ (.+?) in [\d.]+s(?: \([^)]*\))? =+\s*$/gm)].pop()?.[1] ?? "";
  const failed = num(summary.match(/(\d+) failed/));
  const passed = num(summary.match(/(\d+) passed/));
  const errors = num(summary.match(/(\d+) errors?/)) ?? 0;
  const failing = uniq([...o.matchAll(/^FAILED (\S+?)(?: - .*)?$/gm)].map((m) => m[1]!));
  if (errors > 0 || /error(s)? during collection|ERROR collecting/.test(o) || code === 2 || code === 3 || code === 4) {
    return verdict("pytest", "broken", "tests failed to collect or import", { passed, failed });
  }
  if (code === 5 || (!failed && !passed)) return verdict("pytest", "empty", "no test ran");
  if (failed) return verdict("pytest", "fail", `${failed} failing`, { passed, failed, failing });
  return code === 0 ? verdict("pytest", "pass", `${passed} passing`, { passed, failed }) : verdict("pytest", "broken", `exited ${code}`);
}

function judgeGo(o: string, code: number | null): Verdict {
  const failing = uniq([...o.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]!));
  const passedCount = [...o.matchAll(/^\s*--- PASS: /gm)].length;
  if (/\[build failed\]|\[setup failed\]|^# .+\n.+: (undefined|cannot|syntax error)/m.test(o)) {
    return verdict("go", "broken", "the package did not build", { failing });
  }
  if (failing.length) return verdict("go", "fail", `${failing.length} failing`, { failing, failed: failing.length, passed: passedCount || null });
  if (/\[no test files\]/.test(o) && !/^ok\s/m.test(o)) return verdict("go", "empty", "no test files");
  if (code === 0) return verdict("go", "pass", "ok", { passed: passedCount || null });
  return verdict("go", "broken", `exited ${code} with no failing test`);
}

function judgeCargo(o: string, code: number | null): Verdict {
  const results = [...o.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/gm)];
  const passed = results.reduce((s, m) => s + Number(m[2]), 0);
  const failed = results.reduce((s, m) => s + Number(m[3]), 0);
  const failing = uniq([
    ...[...o.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((m) => m[1]!),
    ...[...o.matchAll(/^(\S+) --- FAILED$/gm)].map((m) => m[1]!),
  ]);
  if (/^error(\[E\d+\])?: /m.test(o) && results.length === 0) return verdict("cargo", "broken", "the crate did not compile");
  if (failed > 0) return verdict("cargo", "fail", `${failed} failing`, { passed, failed, failing });
  if (results.length === 0) return verdict("cargo", code === 0 ? "empty" : "broken", code === 0 ? "no test ran" : `exited ${code}`);
  if (passed === 0) return verdict("cargo", "empty", "no test ran", { passed, failed });
  return code === 0 ? verdict("cargo", "pass", `${passed} passing`, { passed, failed }) : verdict("cargo", "broken", `exited ${code}`);
}

export function judgeRun(input: RunInput): Verdict {
  const runner = detect(input.command, input.output);
  if (input.timedOut) return verdict(runner, "timeout", "the run hit its time limit and was stopped");
  if (input.code === null) return verdict(runner, "broken", "the command could not start");
  const o = input.output;
  switch (runner) {
    case "bun": return judgeBun(o, input.code);
    case "vitest": return judgeVitest(o, input.code);
    case "jest": return judgeJest(o, input.code);
    case "pytest": return judgePytest(o, input.code);
    case "go": return judgeGo(o, input.code);
    case "cargo": return judgeCargo(o, input.code);
    default:
      return input.code === 0
        ? verdict("generic", "pass", "exit code 0", { weak: true })
        : verdict("generic", "fail", `exit code ${input.code} (runner not recognised: judged by exit code only)`, { weak: true });
  }
}

/** Failures in `now` that the baseline did not already have. */
export function newFailures(now: string[], baseline: string[]): string[] {
  const before = new Set(baseline);
  return now.filter((n) => !before.has(n));
}
