import { describe, it, expect } from "bun:test";
import {
  REWORD_ENV_PREFIX, SEQUENCE_EDITOR, TODO_ENV_VAR,
  buildRebaseTodo, isNoopPlan, isRebaseAction,
} from "./rebase-todo.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("buildRebaseTodo", () => {
  it("writes one line per commit, oldest first", () => {
    const { todo } = buildRebaseTodo([
      { hash: A, action: "pick", subject: "first" },
      { hash: B, action: "pick", subject: "second" },
    ]);

    expect(todo).toBe(`pick ${A} first\npick ${B} second\n`);
  });

  it("keeps squash and fixup actions", () => {
    const { todo } = buildRebaseTodo([
      { hash: A, action: "pick", subject: "base" },
      { hash: B, action: "squash", subject: "fold in" },
      { hash: C, action: "fixup", subject: "typo" },
    ]);

    expect(todo).toBe(`pick ${A} base\nsquash ${B} fold in\nfixup ${C} typo\n`);
  });

  it("omits a dropped commit rather than writing a drop line", () => {
    const { todo } = buildRebaseTodo([
      { hash: A, action: "pick", subject: "keep" },
      { hash: B, action: "drop", subject: "remove" },
    ]);

    expect(todo).toBe(`pick ${A} keep\n`);
    expect(todo).not.toContain("drop");
  });

  it("refuses a plan that drops everything", () => {
    expect(() => buildRebaseTodo([{ hash: A, action: "drop" }]))
      .toThrow(/nothing to rebase/);
  });

  it("refuses to squash the oldest kept commit", () => {
    // There is no earlier commit for it to fold into; git would abort.
    expect(() => buildRebaseTodo([
      { hash: A, action: "squash", subject: "x" },
      { hash: B, action: "pick", subject: "y" },
    ])).toThrow(/oldest kept commit/);
  });

  it("looks past dropped commits when checking the oldest kept one", () => {
    expect(() => buildRebaseTodo([
      { hash: A, action: "drop" },
      { hash: B, action: "fixup", subject: "y" },
    ])).toThrow(/oldest kept commit/);
  });

  it("refuses a hash that is not a hash", () => {
    expect(() => buildRebaseTodo([{ hash: "--exec=rm -rf /", action: "pick" }]))
      .toThrow(/Invalid commit hash/);
  });

  it("collapses a multi-line subject so it cannot add a second command", () => {
    const { todo } = buildRebaseTodo([
      { hash: A, action: "pick", subject: "first line\nexec touch /tmp/pwned" },
    ]);

    expect(todo.trimEnd().split("\n")).toHaveLength(1);
    expect(todo).toBe(`pick ${A} first line exec touch /tmp/pwned\n`);
  });

  it("writes a bare command when a commit has no subject", () => {
    expect(buildRebaseTodo([{ hash: A, action: "pick" }]).todo).toBe(`pick ${A}\n`);
  });

  it("ends with a newline so git can parse the last command", () => {
    expect(buildRebaseTodo([{ hash: A, action: "pick", subject: "x" }]).todo.endsWith("\n")).toBe(true);
  });
});

describe("isRebaseAction", () => {
  it("accepts every supported action", () => {
    for (const action of ["pick", "reword", "edit", "squash", "fixup", "drop"]) {
      expect(isRebaseAction(action)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isRebaseAction("exec")).toBe(false);
    expect(isRebaseAction(undefined)).toBe(false);
  });
});

describe("buildRebaseTodo — reword", () => {
  it("picks the commit and amends it from an environment variable", () => {
    const { todo, env } = buildRebaseTodo([
      { hash: A, action: "reword", subject: "old subject", message: "new subject" },
    ]);

    // The message never enters the todo text, so nothing in it can be read as a
    // second command however it is punctuated.
    expect(todo).toBe(
      `pick ${A} old subject\nexec git commit --amend --allow-empty -m "$${REWORD_ENV_PREFIX}0"\n`,
    );
    expect(env).toEqual({ [`${REWORD_ENV_PREFIX}0`]: "new subject" });
  });

  it("numbers each reword separately", () => {
    const { todo, env } = buildRebaseTodo([
      { hash: A, action: "reword", subject: "one", message: "first" },
      { hash: B, action: "pick", subject: "two" },
      { hash: C, action: "reword", subject: "three", message: "third" },
    ]);

    expect(env).toEqual({
      [`${REWORD_ENV_PREFIX}0`]: "first",
      [`${REWORD_ENV_PREFIX}1`]: "third",
    });
    expect(todo).toContain(`$${REWORD_ENV_PREFIX}1`);
  });

  it("keeps a message that would be a shell disaster inline", () => {
    const nasty = '"; rm -rf / #';
    const { env } = buildRebaseTodo([
      { hash: A, action: "reword", subject: "x", message: nasty },
    ]);

    expect(env[`${REWORD_ENV_PREFIX}0`]).toBe(nasty);
  });

  it("keeps a multi-line message whole, unlike a subject", () => {
    const { env } = buildRebaseTodo([
      { hash: A, action: "reword", subject: "x", message: "title\n\nbody line" },
    ]);

    expect(env[`${REWORD_ENV_PREFIX}0`]).toBe("title\n\nbody line");
  });

  it("refuses a reword with no message", () => {
    expect(() => buildRebaseTodo([{ hash: A, action: "reword", subject: "x", message: "   " }]))
      .toThrow(/Reword needs a new message/);
    expect(() => buildRebaseTodo([{ hash: A, action: "reword", subject: "x" }]))
      .toThrow(/Reword needs a new message/);
  });

  it("adds no environment when nothing is reworded", () => {
    expect(buildRebaseTodo([{ hash: A, action: "pick" }]).env).toEqual({});
  });
});

describe("buildRebaseTodo — edit", () => {
  it("writes edit straight through, since git only stops there", () => {
    const { todo, env } = buildRebaseTodo([
      { hash: A, action: "pick", subject: "base" },
      { hash: B, action: "edit", subject: "stop here" },
    ]);

    expect(todo).toBe(`pick ${A} base\nedit ${B} stop here\n`);
    expect(env).toEqual({});
  });
});

describe("isNoopPlan", () => {
  it("recognises an unchanged plan", () => {
    expect(isNoopPlan(
      [{ hash: A, action: "pick" }, { hash: B, action: "pick" }],
      [A, B],
    )).toBe(true);
  });

  it("sees a reorder", () => {
    expect(isNoopPlan(
      [{ hash: B, action: "pick" }, { hash: A, action: "pick" }],
      [A, B],
    )).toBe(false);
  });

  it("sees a changed action", () => {
    expect(isNoopPlan(
      [{ hash: A, action: "pick" }, { hash: B, action: "squash" }],
      [A, B],
    )).toBe(false);
  });
});

describe("sequence editor wiring", () => {
  it("reads the todo from an environment variable, not from the command string", () => {
    // Git pastes the editor string into a shell command; keeping the todo in an
    // env var means no quoting of the todo or of the todo path can go wrong.
    expect(SEQUENCE_EDITOR).toContain(`$${TODO_ENV_VAR}`);
    expect(SEQUENCE_EDITOR.trimEnd().endsWith(">")).toBe(true);
  });
});
