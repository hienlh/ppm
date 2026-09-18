import { describe, test, expect } from "bun:test";
import {
  parseDesktopEntry, stripFieldCodes, execBinary,
} from "../../../../src/services/system-services/desktop-entry.ts";
import {
  appIdFromCgroup, unescapeSystemd,
} from "../../../../src/services/system-services/app-cgroup-linux.ts";

// The real code.desktop from this host, actions included.
const CODE = [
  "[Desktop Entry]",
  "Name=Visual Studio Code",
  "Comment=Code Editing. Redefined.",
  "GenericName=Text Editor",
  "Exec=code %F",
  "Icon=vscode",
  "Type=Application",
  "StartupNotify=false",
  "StartupWMClass=Code",
  "Actions=new-empty-window;",
  "",
  "[Desktop Action new-empty-window]",
  "Name=New Empty Window",
  "Exec=code --new-window %F",
  "Icon=vscode",
].join("\n");

describe("parseDesktopEntry", () => {
  test("reads the four fields it needs from the Desktop Entry group", () => {
    expect(parseDesktopEntry("code", CODE)).toEqual({
      id: "code", name: "Visual Studio Code", icon: "vscode", exec: "code", noDisplay: false,
    });
  });

  test("an action's Name never overwrites the app's", () => {
    // Scanning the whole file would answer "New Empty Window" here.
    expect(parseDesktopEntry("code", CODE)?.name).toBe("Visual Studio Code");
  });

  test("a translation is ignored in favour of the unlocalised value", () => {
    const text = "[Desktop Entry]\nType=Application\nName=Files\nName[vi]=Tep\nName[de]=Dateien\n";
    expect(parseDesktopEntry("f", text)?.name).toBe("Files");
  });

  test("anything that is not a launchable application is dropped", () => {
    expect(parseDesktopEntry("l", "[Desktop Entry]\nType=Link\nName=Site\nURL=http://x\n")).toBeNull();
    expect(parseDesktopEntry("h", "[Desktop Entry]\nType=Application\nName=X\nHidden=true\n")).toBeNull();
    expect(parseDesktopEntry("n", "[Desktop Entry]\nType=Application\n")).toBeNull();
    expect(parseDesktopEntry("e", "")).toBeNull();
  });

  test("NoDisplay is reported, not silently dropped - the caller decides", () => {
    const text = "[Desktop Entry]\nType=Application\nName=URL Handler\nNoDisplay=true\nExec=code --open-url %U\n";
    expect(parseDesktopEntry("h", text)?.noDisplay).toBe(true);
  });

  test("comments, blank lines and a valueless key do not derail the parse", () => {
    const text = "[Desktop Entry]\n# a comment\n\nType=Application\nName=X\nbroken\n=novalue\nIcon=x\n";
    expect(parseDesktopEntry("x", text)).toEqual({ id: "x", name: "X", icon: "x", exec: null, noDisplay: false });
  });
});

describe("stripFieldCodes", () => {
  test("every code the entries on this host use", () => {
    expect(stripFieldCodes("code %F")).toBe("code");
    expect(stripFieldCodes("dolphin %u")).toBe("dolphin");
    expect(stripFieldCodes("app %f %U %i %c %k")).toBe("app");
  });

  test("a doubled percent survives as one", () => {
    expect(stripFieldCodes("printf 100%% %U")).toBe("printf 100%");
  });

  test("a percent that is not a field code is left alone", () => {
    expect(stripFieldCodes("prog --fmt %p")).toBe("prog --fmt %p");
  });
});

describe("execBinary", () => {
  test("the program name, not the path or the wrapper", () => {
    expect(execBinary("/usr/bin/code")).toBe("code");
    expect(execBinary("code")).toBe("code");
    expect(execBinary("env GDK_BACKEND=x11 /opt/foo/bin/foo --flag")).toBe("foo");
    expect(execBinary('"/opt/my app/bin/prog" --x')).toBe("prog");
  });

  test("nothing to run is null", () => {
    expect(execBinary(null)).toBeNull();
    expect(execBinary("")).toBeNull();
    expect(execBinary("A=1 B=2")).toBeNull();
  });
});

describe("appIdFromCgroup", () => {
  const under = (unit: string) =>
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/" + unit + "\n";
  const ESCAPED_TRAY = "app-arch" + String.raw`\x2d` + "update" + String.raw`\x2d` + "tray@autostart.service";

  test("the four shapes a real KDE/systemd session produces", () => {
    expect(appIdFromCgroup(under("app-code-1278493.scope"))).toBe("code");
    expect(appIdFromCgroup(under("app-com.anthropic.Claude-1239199.scope"))).toBe("com.anthropic.Claude");
    expect(appIdFromCgroup(under("app-code@b7f20b90162241c3a47065ec91d99821.service"))).toBe("code");
    expect(appIdFromCgroup(under(ESCAPED_TRAY))).toBe("arch-update-tray");
  });

  test("a dotted id keeps every dot - only the unit suffix is removed", () => {
    expect(appIdFromCgroup(under("app-dev.lizardbyte.app.Sunshine.service")))
      .toBe("dev.lizardbyte.app.Sunshine");
    expect(appIdFromCgroup(under("app-io.missioncenter.MissionCenter@24a0318c62da45b18a199903c7f81ca7.service")))
      .toBe("io.missioncenter.MissionCenter");
  });

  test("the OUTERMOST app unit names the app, not a scope nested inside it", () => {
    expect(appIdFromCgroup("0::/user.slice/app.slice/app-code@hash.service/inner-app-other-1.scope\n"))
      .toBe("code");
  });

  test("a process outside any app scope has no app", () => {
    expect(appIdFromCgroup("0::/system.slice/sshd.service\n")).toBeNull();
    expect(appIdFromCgroup("0::/init.scope\n")).toBeNull();
    expect(appIdFromCgroup("")).toBeNull();
  });

  test("cgroup v1's several lines are searched too", () => {
    expect(appIdFromCgroup("8:cpu:/other\n1:name=systemd:/user.slice/app.slice/app-vlc-9.scope\n"))
      .toBe("vlc");
  });

  test("unescapeSystemd leaves ordinary text alone", () => {
    expect(unescapeSystemd("plain-name")).toBe("plain-name");
    expect(unescapeSystemd(String.raw`a\x2db\x5fc`)).toBe("a-b_c");
  });
});
