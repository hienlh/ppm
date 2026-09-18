import { describe, test, expect } from "bun:test";
import {
  parseListUnits, parseShowBlock, parseShowRecords,
  toServiceInfo, keepUnit, parseJournalJson, journalMessage, isListedUnit,
  type ListUnitsRow,
} from "../../../../src/services/system-services/systemd-parse.ts";

const row = (over: Partial<ListUnitsRow> = {}): ListUnitsRow => ({
  unit: "sshd.service", loadState: "loaded", activeState: "active",
  subState: "running", description: "OpenSSH Daemon", ...over,
});

describe("parseListUnits", () => {
  test("the five columns, with the description keeping its spaces", () => {
    const out = parseListUnits(
      "alsa-restore.service    loaded active exited  Save/Restore Sound Card State\n" +
      "ananicy-cpp.service     loaded active running Ananicy-Cpp - ANother Auto NICe daemon in C++\n",
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      unit: "alsa-restore.service", loadState: "loaded", activeState: "active",
      subState: "exited", description: "Save/Restore Sound Card State",
    });
    expect(out[1]?.description).toBe("Ananicy-Cpp - ANother Auto NICe daemon in C++");
  });

  test("a status bullet is stripped rather than read as the unit name", () => {
    const out = parseListUnits("● sshd.service loaded failed failed OpenSSH Daemon\n");
    expect(out[0]?.unit).toBe("sshd.service");
    expect(out[0]?.activeState).toBe("failed");
  });

  test("blank lines and a truncated row are skipped, not turned into empty units", () => {
    expect(parseListUnits("\n\n   \nfoo.service loaded\n")).toEqual([]);
  });

  test("a unit with no description is still a row", () => {
    expect(parseListUnits("x.mount loaded active mounted\n")[0]?.description).toBe("");
  });
});

describe("parseShowRecords", () => {
  const dump = "Id=sshd.service\nActiveState=active\nMainPID=850\n\n" +
               "Id=ananicy-cpp.service\nActiveState=active\nMainPID=766\n";

  test("blocks are separated by a blank line", () => {
    const byId = parseShowRecords(dump);
    expect([...byId.keys()]).toEqual(["sshd.service", "ananicy-cpp.service"]);
    expect(byId.get("sshd.service")?.MainPID).toBe("850");
  });

  test("an alias comes back under its CANONICAL name, so position would misattribute", () => {
    // `systemctl show dbus.service` really answers Id=dbus-broker.service here.
    const byId = parseShowRecords("Id=dbus-broker.service\nActiveState=active\n");
    expect(byId.has("dbus.service")).toBe(false);
    expect(byId.has("dbus-broker.service")).toBe(true);
  });

  test("a value may contain '=' and is kept whole", () => {
    expect(parseShowBlock("Description=a=b=c\n").Description).toBe("a=b=c");
  });

  test("a block with no Id is dropped rather than keyed under undefined", () => {
    expect(parseShowRecords("ActiveState=active\n").size).toBe(0);
  });
});

describe("toServiceInfo", () => {
  test("running, failed and enabled are Mission Center's three derivations", () => {
    const info = toServiceInfo(row(), "system", { Id: "sshd.service", MainPID: "850" , UnitFileState: "enabled" });
    expect(info.running).toBe(true);
    expect(info.failed).toBe(false);
    expect(info.enabled).toBe(true);
    expect(info.mainPid).toBe(850);
  });

  test("static, indirect and alias all count as NOT enabled", () => {
    for (const state of ["static", "indirect", "alias", "generated", "masked"]) {
      expect(toServiceInfo(row(), "system", { Id: "x", UnitFileState: state }).enabled).toBe(false);
      expect(toServiceInfo(row(), "system", { Id: "x", UnitFileState: state }).unitFileState).toBe(state);
    }
  });

  test("activating is neither running nor failed", () => {
    const info = toServiceInfo(row({ activeState: "activating" }), "system", { Id: "x", UnitFileState: "enabled" });
    expect(info.running).toBe(false);
    expect(info.failed).toBe(false);
  });

  test("a failed unit is flagged from ActiveState, not from SubState", () => {
    expect(toServiceInfo(row({ activeState: "failed", subState: "failed" }), "system", { Id: "x", UnitFileState: "enabled" }).failed).toBe(true);
  });

  test("MainPID 0 means the unit has none, which is null and not 0", () => {
    expect(toServiceInfo(row(), "system", { Id: "x", MainPID: "0" , UnitFileState: "static" }).mainPid).toBeNull();
    expect(toServiceInfo(row(), "system", { Id: "x", UnitFileState: "static" }).mainPid).toBeNull();
  });

  test("a unit with no unit file reports null, not an empty string", () => {
    expect(toServiceInfo(row(), "system", { Id: "x", UnitFileState: "" }).unitFileState).toBeNull();
  });

  test("show wins over the list row, which is a tick older", () => {
    const info = toServiceInfo(row({ activeState: "active" }), "user", { Id: "x", ActiveState: "failed" , UnitFileState: "enabled" });
    expect(info.activeState).toBe("failed");
    expect(info.scope).toBe("user");
  });
});

describe("keepUnit", () => {
  test("only the three unit types Mission Center lists", () => {
    expect(isListedUnit("a.service")).toBe(true);
    expect(isListedUnit("a.socket")).toBe(true);
    expect(isListedUnit("a.mount")).toBe(true);
    expect(isListedUnit("a.timer")).toBe(false);
    expect(keepUnit(row({ unit: "a.timer" }))).toBe(false);
  });

  test("a name systemd knows with no file behind it is dropped", () => {
    expect(keepUnit(row({ loadState: "not-found" }))).toBe(false);
  });

  test("a masked unit stays in the list", () => {
    expect(keepUnit(row({ loadState: "masked" }))).toBe(true);
  });
});

describe("parseJournalJson", () => {
  test("microseconds become epoch ms", () => {
    const out = parseJournalJson(JSON.stringify({ __REALTIME_TIMESTAMP: "1789146956023180", MESSAGE: "started" }));
    expect(out).toEqual([{ ts: 1789146956023, message: "started" }]);
  });

  test("a message that is not valid UTF-8 arrives as a byte array", () => {
    const out = parseJournalJson(JSON.stringify({ __REALTIME_TIMESTAMP: "1000", MESSAGE: [104, 105] }));
    expect(out[0]?.message).toBe("hi");
  });

  test("a multi-line message stays ONE entry", () => {
    const out = parseJournalJson(JSON.stringify({ __REALTIME_TIMESTAMP: "1000", MESSAGE: "trace:\n  #0 foo\n  #1 bar" }));
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain("#1 bar");
  });

  test("a malformed line or an entry with no message is skipped, never a blank row", () => {
    expect(parseJournalJson("not json\n{\"MESSAGE\":null}\n\n")).toEqual([]);
  });

  test("journalMessage rejects anything that is neither a string nor bytes", () => {
    expect(journalMessage({})).toBeNull();
    expect(journalMessage(undefined)).toBeNull();
    expect(journalMessage("x")).toBe("x");
  });
});
