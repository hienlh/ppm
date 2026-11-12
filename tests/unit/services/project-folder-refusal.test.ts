/**
 * The folders an AI may not register as a project (or move one to): registering a folder lets the
 * Assistant read inside it without asking, so a folder holding logins or keys is refused before
 * anyone is asked.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { join, parse, resolve } from "node:path";
import { projectFolderRefusal } from "../../../src/services/project-folder-refusal.ts";

const home = resolve("/users/me");
const ppmDir = join(home, ".ppm");
const refuse = (path: string, platform = "linux", privateRoots: string[] = []) =>
  projectFolderRefusal(path, home, ppmDir, { platform, privateRoots });

describe("projectFolderRefusal", () => {
  it("lets an ordinary project folder through", () => {
    expect(refuse(join(home, "code", "app"))).toBeNull();
    expect(refuse(resolve("/srv/work/app"))).toBeNull();
  });

  it("refuses a drive, the home folder, anything holding it, and PPM's own folder", () => {
    expect(refuse(parse(home).root)).toContain("whole drive");
    expect(refuse(home)).toContain("home folder");
    expect(refuse(resolve(home, ".."))).toContain("home folder");
    expect(refuse(join(ppmDir, "codex-accounts"))).toContain("PPM's own data");
  });

  it("refuses a browser profile and a tool's logins in the home folder's application-state area", () => {
    expect(refuse(join(home, ".mozilla", "firefox", "abcd.default-release"))).toContain(".mozilla");
    expect(refuse(join(home, ".config", "google-chrome"))).toContain(".config");
    expect(refuse(join(home, ".ssh"))).toContain(".ssh");
    expect(refuse(join(home, "AppData", "Roaming", "Mozilla", "Firefox", "Profiles", "x"), "win32")).toContain("AppData");
    expect(refuse(join(home, "Library", "Application Support", "Google", "Chrome"), "darwin")).toContain("Library");
    // A folder named like one on a platform that does not use it is an ordinary folder.
    expect(refuse(join(home, "AppData", "notes"), "linux")).toBeNull();
  });

  it("refuses a folder in or holding a private store outside the home folder", () => {
    const store = resolve("/srv/secrets");
    expect(refuse(join(store, "deep"), "linux", [store])).toContain(`is inside ${store}`);
    expect(refuse(resolve("/srv"), "linux", [store])).toContain(`holds ${store}`);
    expect(refuse(resolve("/srv/other"), "linux", [store])).toBeNull();
  });

  it("uses the Assistant's own list of private stores when none is given", () => {
    expect(projectFolderRefusal(join(home, "code", "app"), home, ppmDir)).toBeNull();
    expect(projectFolderRefusal(join(home, ".aws"), home, ppmDir)).not.toBeNull();
  });
});
