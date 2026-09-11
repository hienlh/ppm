import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  isCodexGeneratedImagePath,
  isCredentialPath,
  assertNotPpmDir,
  assertNotPpmSubtree,
} from "../../../src/services/fs-credential-path-guard.ts";
import { getPpmDir, _resetPpmDir } from "../../../src/services/ppm-dir.ts";

/**
 * Codex writes generated pictures inside its CODEX_HOME, which PPM places under
 * the PPM directory — the one subtree the credential guard refuses wholesale.
 * These cover the narrow read-only hole that lets the chat render such an image
 * while `auth.json` beside it stays refused.
 *
 * Pure path math, no filesystem: nothing is created, so nothing can be deleted.
 * PPM_HOME still points at a scratch path for the duration, because a stale
 * cached real `~/.ppm` would make every assertion here meaningless.
 */
const SCRATCH = resolve(join(tmpdir(), "ppm-codex-image-guard-test"));
let previousHome: string | undefined;

beforeAll(() => {
  previousHome = process.env.PPM_HOME;
  process.env.PPM_HOME = SCRATCH;
  _resetPpmDir();
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = previousHome;
  _resetPpmDir();
});

const accounts = () => join(getPpmDir(), "codex-accounts");
const generated = (...rest: string[]) => join(accounts(), "acct-1", "generated_images", ...rest);

describe("isCodexGeneratedImagePath", () => {
  it("accepts a generated image", () => {
    expect(isCodexGeneratedImagePath(generated("thread-1", "call_abc.png"))).toBe(true);
  });

  it("accepts a file directly under generated_images", () => {
    expect(isCodexGeneratedImagePath(generated("loose.png"))).toBe(true);
  });

  it("refuses the generated_images directory itself", () => {
    // A directory is not an image; only something inside it can be served.
    expect(isCodexGeneratedImagePath(join(accounts(), "acct-1", "generated_images"))).toBe(false);
  });

  it("refuses auth.json sitting beside generated_images", () => {
    expect(isCodexGeneratedImagePath(join(accounts(), "acct-1", "auth.json"))).toBe(false);
  });

  it("refuses the other databases in an account home", () => {
    for (const name of ["logs_2.sqlite", "thread_history_1.sqlite", "state_5.sqlite", "sessions"]) {
      expect(isCodexGeneratedImagePath(join(accounts(), "acct-1", name))).toBe(false);
    }
  });

  it("refuses the account home and the accounts root", () => {
    expect(isCodexGeneratedImagePath(join(accounts(), "acct-1"))).toBe(false);
    expect(isCodexGeneratedImagePath(accounts())).toBe(false);
  });

  it("refuses the PPM config database", () => {
    expect(isCodexGeneratedImagePath(join(getPpmDir(), "ppm.db"))).toBe(false);
  });

  it("refuses a look-alike segment one level off", () => {
    // `generated_images` must be the second segment under the accounts root, so
    // a directory of that name nested deeper does not open the door.
    expect(isCodexGeneratedImagePath(join(accounts(), "acct-1", "sessions", "generated_images", "x.png")))
      .toBe(false);
    expect(isCodexGeneratedImagePath(join(getPpmDir(), "generated_images", "x.png"))).toBe(false);
  });

  it("refuses a path outside the PPM dir entirely", () => {
    expect(isCodexGeneratedImagePath(resolve(join(tmpdir(), "elsewhere", "x.png")))).toBe(false);
  });
});

describe("guard doors", () => {
  it("still classifies a generated image as a credential path", () => {
    // The exception lives in the read door, not in the classification — so any
    // future door that only consults isCredentialPath stays closed by default.
    expect(isCredentialPath(generated("thread-1", "call_abc.png"))).toBe(true);
  });

  it("permits READING a generated image", () => {
    expect(() => assertNotPpmDir(generated("thread-1", "call_abc.png"))).not.toThrow();
  });

  it("still refuses reading auth.json", () => {
    expect(() => assertNotPpmDir(join(accounts(), "acct-1", "auth.json"))).toThrow("Access denied");
  });

  it("still refuses COPYING OR MOVING a generated image", () => {
    // Read-only on purpose: nothing may be written into, or relocated out of,
    // an account home through a generic file route.
    expect(() => assertNotPpmSubtree(generated("thread-1", "call_abc.png"))).toThrow();
  });
});
