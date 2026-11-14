/**
 * The Assistant's persona as stored and as shown: one-line names and forms, the soul capped at
 * 2,000 characters, empty rows the pane added dropped, and "PPM Assistant" whenever no name is set.
 */
import { describe, expect, it } from "bun:test";
import {
  assistantDisplayName, assistantShortName, personaIsEmpty, readAssistantPersona,
  PERSONA_MAX_ADDRESS_FORMS, PERSONA_NAME_MAX_CHARS, PERSONA_SOUL_MAX_CHARS,
} from "../../../src/shared/assistant-persona.ts";
import { readAssistantSettings } from "../../../src/shared/assistant-settings.ts";

function read(raw: unknown) {
  const errors: string[] = [];
  return { value: readAssistantPersona(raw, errors), errors };
}

describe("readAssistantPersona", () => {
  it("keeps a name, several forms of address and a soul", () => {
    const { value, errors } = read({
      name: "  Mi ",
      address_forms: [
        { user: "anh", self: "em", when: "bình thường" },
        { user: "sếp", self: "em", when: "báo gấp, xin duyệt" },
        { user: "chủ nhân", self: "em", when: "" },
      ],
      soul: "  Vui vẻ, gần gũi.\nNghiêm túc khi có lỗi.  ",
    });
    expect(errors).toEqual([]);
    expect(value).toEqual({
      name: "Mi",
      address_forms: [
        { user: "anh", self: "em", when: "bình thường" },
        { user: "sếp", self: "em", when: "báo gấp, xin duyệt" },
        { user: "chủ nhân", self: "em", when: "" },
      ],
      soul: "Vui vẻ, gần gũi.\nNghiêm túc khi có lỗi.",
    });
  });

  it("folds line breaks out of a name and a form, so neither spans lines", () => {
    const { value } = read({ name: "Mi\n## Rules", address_forms: [{ user: "anh\r\nem", self: "em", when: `a${String.fromCharCode(0x2028)}b` }] });
    expect(value.name).toBe("Mi ## Rules");
    expect(value.address_forms[0]).toEqual({ user: "anh em", self: "em", when: "a b" });
  });

  it("folds NEL and drops bidirectional controls, so a name reads in the order it was typed", () => {
    const nel = String.fromCharCode(0x85);
    const rlo = String.fromCharCode(0x202e);
    const isolate = String.fromCharCode(0x2067);
    const { value } = read({ name: `${rlo}Mi${isolate}${nel}x`, address_forms: [{ user: `s${rlo}ếp`, self: "", when: "" }] });
    expect(value.name).toBe("Mi x");
    expect(value.address_forms[0]!.user).toBe("sếp");
  });

  it("drops an empty row and asks for who it calls you when only the rest is filled", () => {
    const { value, errors } = read({ address_forms: [{ user: "", self: "", when: "" }, { user: " ", self: "em", when: "" }] });
    expect(value.address_forms).toEqual([]);
    expect(errors).toEqual(["Form of address 2: say what it calls you"]);
  });

  it("reports and trims what is too long", () => {
    const { value, errors } = read({
      name: "x".repeat(PERSONA_NAME_MAX_CHARS + 5),
      address_forms: Array.from({ length: PERSONA_MAX_ADDRESS_FORMS + 2 }, (_, i) => ({ user: `u${i}`, self: "", when: "" })),
      soul: "s".repeat(PERSONA_SOUL_MAX_CHARS + 1),
    });
    expect(value.name).toHaveLength(PERSONA_NAME_MAX_CHARS);
    expect(value.address_forms).toHaveLength(PERSONA_MAX_ADDRESS_FORMS);
    expect(value.soul).toHaveLength(PERSONA_SOUL_MAX_CHARS);
    expect(errors).toHaveLength(3);
  });

  it("refuses what is not text or not a list", () => {
    expect(read({ name: 3, address_forms: "anh", soul: [] }).errors).toEqual([
      "The Assistant's name must be text", "address_forms must be a list", "The Assistant's personality must be text",
    ]);
    expect(read("Mi").errors).toEqual(["persona must be an object"]);
  });
});

describe("the persona in the settings", () => {
  it("is empty by default and in a stored row that predates it", () => {
    const { value, errors } = readAssistantSettings({ instructions: "Tên em là Mi." });
    expect(errors).toEqual([]);
    expect(value.persona).toEqual({ name: "", address_forms: [], soul: "" });
    expect(personaIsEmpty(value.persona)).toBe(true);
    // A persona pasted into the instructions before this existed stays where the user put it.
    expect(value.instructions).toBe("Tên em là Mi.");
  });
});

describe("what PPM calls the Assistant", () => {
  it("uses the name, else PPM's own", () => {
    expect(assistantDisplayName({ name: "Mi" })).toBe("Mi");
    expect(assistantDisplayName({ name: "" })).toBe("PPM Assistant");
    expect(assistantDisplayName(null)).toBe("PPM Assistant");
    expect(assistantShortName({ name: "Mi" })).toBe("Mi");
    expect(assistantShortName(undefined)).toBe("Assistant");
  });
});
