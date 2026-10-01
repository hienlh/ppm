/**
 * The XML plist parser every darwin source goes through. Checked once by hand
 * against Python's `plistlib` over every capture in `fixtures/darwin/` plus a
 * 116 KB `ioreg` power-manager node: identical output, except integers above
 * 2^53, which a JS number cannot hold exactly. Pinned here by the values those
 * captures are read for.
 */
import { describe, expect, test } from "bun:test";
import {
  decodeEntities, isPlistDict, parsePlistXml, plistArray, plistBool, plistCString, plistData, plistDict,
  plistNumber, plistString,
} from "../../../../src/services/system-metrics/plist-xml.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}\n</plist>\n`;

describe("the value elements", () => {
  test("every scalar", () => {
    const v = plistDict(parsePlistXml(doc(`<dict>
      <key>s</key><string>Apple SSD</string>
      <key>i</key><integer>1000555581440</integer>
      <key>neg</key><integer>-5</integer>
      <key>r</key><real>0.5</real>
      <key>t</key><true/>
      <key>f</key><false/>
      <key>d</key><data>
        AAECAw==
      </data>
      <key>when</key><date>2026-09-30T08:00:00Z</date>
    </dict>`)))!;
    expect(v.s).toBe("Apple SSD");
    expect(v.i).toBe(1000555581440);
    expect(v.neg).toBe(-5);
    expect(v.r).toBe(0.5);
    expect(v.t).toBe(true);
    expect(v.f).toBe(false);
    expect([...plistData(v.d)!]).toEqual([0, 1, 2, 3]);
    expect(v.when).toBe("2026-09-30T08:00:00Z");
  });

  test("empty elements", () => {
    const v = plistDict(parsePlistXml(doc("<dict><key>a</key><array/><key>b</key><dict/><key>c</key><string/><key>d</key><data/></dict>")))!;
    expect(v.a).toEqual([]);
    expect(isPlistDict(v.b)).toBe(true);
    expect(v.c).toBe("");
    expect(plistData(v.d)!.byteLength).toBe(0);
  });

  test("nesting", () => {
    const v = plistArray(parsePlistXml(doc("<array><dict><key>x</key><array><integer>1</integer><integer>2</integer></array></dict></array>")))!;
    expect(plistDict(v[0])!.x).toEqual([1, 2]);
  });

  test("a string keeps its whitespace; data sheds the line breaks ioreg wraps it in", () => {
    const v = plistDict(parsePlistXml(doc("<dict><key>k</key><string>  two  spaces </string><key>d</key><data>\n\t\tAAEC\n\t\tAw==\n\t\t</data></dict>")))!;
    expect(v.k).toBe("  two  spaces ");
    expect([...plistData(v.d)!]).toEqual([0, 1, 2, 3]);
  });
});

describe("text that arrives from outside", () => {
  test("entities are decoded once, so an escaped entity stays text", () => {
    expect(decodeEntities("A &amp; B &lt;x&gt; &quot;q&quot; &apos;a&apos;")).toBe(`A & B <x> "q" 'a'`);
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&#233;&#x1F600;")).toBe("é😀");
    expect(decodeEntities("&bogus; &#xFFFFFFFF;")).toBe("&bogus; &#xFFFFFFFF;");
  });

  test("a device that names itself __proto__ is just a key", () => {
    const v = plistDict(parsePlistXml(doc("<dict><key>__proto__</key><string>USB Stick</string><key>constructor</key><integer>1</integer></dict>")))!;
    expect(v.__proto__).toBe("USB Stick");
    expect(v["constructor" as string]).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(v)).toBeNull();
  });

  test("keys are entity-decoded too", () => {
    expect(Object.keys(plistDict(parsePlistXml(doc("<dict><key>A&amp;B</key><true/></dict>")))!)).toEqual(["A&B"]);
  });
});

describe("anything that is not a well-formed plist is undefined, never a partial answer", () => {
  test.each([
    ["empty", ""],
    ["plain text", "diskutil: command not found"],
    ["an unclosed dict", doc("<dict><key>a</key><string>b</string>")],
    ["a key without a value", doc("<dict><key>a</key></dict>")],
    ["a value without a key", doc("<dict><string>b</string></dict>")],
    ["mismatched tags", doc("<dict><key>a</key><string>b</integer></dict>")],
    ["an unknown element", doc("<dict><key>a</key><uid>1</uid></dict>")],
    ["a non-numeric integer", doc("<dict><key>a</key><integer>ten</integer></dict>")],
    ["bad base64", doc("<dict><key>a</key><data>!!!</data></dict>")],
    ["two roots", doc("<dict/><dict/>")],
  ])("%s", (_label, xml) => {
    expect(parsePlistXml(xml)).toBeUndefined();
  });
});

describe("the real captures", () => {
  test("ioreg's block devices: the SD reader, the internal SSD and a mounted disk image", () => {
    const devices = plistArray(parsePlistXml(darwinFixture("ioreg-block-devices.xml")))!.map(plistDict);
    expect(devices.map((d) => d?.IOObjectClass)).toEqual([
      "AppleSDXCBlockStorageDevice", "IOEmbeddedNVMeBlockDevice", "IODiskImageBlockStorageDeviceOutKernel",
    ]);
    const nvme = devices[1]!;
    expect(plistString(plistDict(nvme["Device Characteristics"])!["Product Name"])).toBe("APPLE SSD AP1024R");
    // Apple Silicon's SSD hangs off the fabric, not PCIe.
    expect(plistDict(nvme["Protocol Characteristics"])!["Physical Interconnect"]).toBe("Apple Fabric");
  });

  test("diskutil list: every whole disk", () => {
    const list = plistDict(parsePlistXml(darwinFixture("diskutil-list.plist")))!;
    expect(plistArray(list.WholeDisks)!.length).toBeGreaterThan(0);
  });

  test("the power manager's node: a frequency table is data", () => {
    const node = plistDict(plistArray(parsePlistXml(darwinFixture("ioreg-pmgr.xml")))![0])!;
    expect(plistData(node["voltage-states5-sram"])!.byteLength).toBe(120);
    expect(plistCString(node.name)).toBe("pmgr");
  });
});

describe("narrowing", () => {
  test("each accessor answers only for its own type", () => {
    expect(plistString(1)).toBeUndefined();
    expect(plistNumber("1")).toBeUndefined();
    expect(plistNumber(Number.NaN)).toBeUndefined();
    expect(plistBool(0)).toBeUndefined();
    expect(plistArray({} as never)).toBeUndefined();
    expect(plistDict([])).toBeUndefined();
    expect(plistDict(new Uint8Array(1))).toBeUndefined();
    expect(plistData("AA==")).toBeUndefined();
  });

  test("a C string written as data stops at its terminator", () => {
    expect(plistCString(new Uint8Array([0x70, 0x6d, 0x67, 0x72, 0, 0x78]))).toBe("pmgr");
    expect(plistCString(new Uint8Array([0]))).toBeUndefined();
    expect(plistCString("plain")).toBe("plain");
  });
});
