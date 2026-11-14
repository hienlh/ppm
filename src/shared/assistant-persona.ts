/**
 * The PPM Assistant's persona, from Settings → PPM Assistant: a name, the ways it may address the
 * user, and a free-text character ("soul"). It changes how the Assistant talks and what PPM calls
 * it on screen and on Telegram — never what it may do: the instruction section built from it
 * (`assistantPersonaSection`) sits after every safety rule and says so.
 *
 * Shared by the server, which stores it and builds the instructions, and the browser, which edits
 * it and shows the name.
 */

export const PERSONA_NAME_MAX_CHARS = 32;
export const PERSONA_SOUL_MAX_CHARS = 2000;
export const PERSONA_MAX_ADDRESS_FORMS = 12;
export const PERSONA_ADDRESS_FIELD_MAX_CHARS = 40;
export const PERSONA_ADDRESS_WHEN_MAX_CHARS = 200;

/** One way of addressing the user, and when to use it ("sếp" – "em": urgent news, approvals). */
export interface AssistantAddressForm {
  /** What the Assistant calls the user ("anh", "sếp", "chủ nhân"…). */
  user: string;
  /** What the Assistant calls itself ("em"); empty leaves it to the Assistant. */
  self: string;
  /** When this form fits; empty means "any time". */
  when: string;
}

export interface AssistantPersona {
  /** Empty: no name, and PPM keeps calling it "PPM Assistant". */
  name: string;
  address_forms: AssistantAddressForm[];
  soul: string;
}

export const DEFAULT_ASSISTANT_PERSONA: AssistantPersona = { name: "", address_forms: [], soul: "" };

/** What PPM calls the Assistant in sentences ("Mi asks", else "PPM Assistant asks"). */
export function assistantDisplayName(persona: Pick<AssistantPersona, "name"> | null | undefined): string {
  return persona?.name || "PPM Assistant";
}

/** The window's titlebar and the Assistant's own head: the name, else the short "Assistant". */
export function assistantShortName(persona: Pick<AssistantPersona, "name"> | null | undefined): string {
  return persona?.name || "Assistant";
}

/** Whether there is anything to tell the Assistant about its persona. */
export function personaIsEmpty(persona: AssistantPersona): boolean {
  return !persona.name && persona.address_forms.length === 0 && !persona.soul;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A character class from code-point ranges; a literal separator in this file would end its line. */
const charClass = (ranges: Array<[number, number]>, flags: string) =>
  new RegExp(`[${ranges.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("")}]+`, flags);

/** C0 and C1 controls (NEL among them) and the two Unicode line and paragraph separators. */
const CONTROLS = charClass([[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029]], "g");

/**
 * Bidirectional embeddings, overrides and isolates: invisible, and able to make "Mi wants to"
 * on a card or in Telegram read in another order than it was written.
 */
const BIDI_CONTROLS = charClass([[0x202a, 0x202e], [0x2066, 0x2069]], "g");

/**
 * Where a multi-line text breaks into lines: CRLF, or any single character a reader — a model
 * included — may take for a line end (CR, LF, NEL, the Unicode separators, vertical tab, form feed).
 */
export const LINE_END = new RegExp(
  `\r\n|[${String.fromCharCode(0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029)}]`,
);

/**
 * One line of text: controls (line breaks included) become spaces, bidirectional controls go,
 * and runs of spaces fold, so a name or an address form can neither span lines in the
 * instructions nor in a Telegram headline, nor read in another order than it was typed.
 */
function oneLine(raw: string): string {
  return raw.replace(BIDI_CONTROLS, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
}

function readLine(raw: unknown, max: number, what: string, errors: string[]): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") { errors.push(`${what} must be text`); return ""; }
  const text = oneLine(raw);
  if (text.length > max) { errors.push(`${what} must be at most ${max} characters`); return text.slice(0, max).trim(); }
  return text;
}

/**
 * Checks and normalises a persona from outside (a request body, a stored row). Never throws:
 * every problem is listed, and the result holds what was valid. A form with no way of addressing
 * the user is dropped silently, since that is what an empty row the pane added looks like.
 */
export function readAssistantPersona(raw: unknown, errors: string[]): AssistantPersona {
  if (raw === undefined || raw === null) return structuredClone(DEFAULT_ASSISTANT_PERSONA);
  if (!isRecord(raw)) { errors.push("persona must be an object"); return structuredClone(DEFAULT_ASSISTANT_PERSONA); }

  const name = readLine(raw.name, PERSONA_NAME_MAX_CHARS, "The Assistant's name", errors);

  const forms: AssistantAddressForm[] = [];
  const rawForms = raw.address_forms ?? [];
  if (!Array.isArray(rawForms)) errors.push("address_forms must be a list");
  else {
    rawForms.forEach((item, i) => {
      const where = `Form of address ${i + 1}`;
      if (!isRecord(item)) { errors.push(`${where} is not an object`); return; }
      const user = readLine(item.user, PERSONA_ADDRESS_FIELD_MAX_CHARS, `${where}: what it calls you`, errors);
      const self = readLine(item.self, PERSONA_ADDRESS_FIELD_MAX_CHARS, `${where}: what it calls itself`, errors);
      const when = readLine(item.when, PERSONA_ADDRESS_WHEN_MAX_CHARS, `${where}: when to use it`, errors);
      if (!user) {
        if (self || when) errors.push(`${where}: say what it calls you`);
        return;
      }
      forms.push({ user, self, when });
    });
    if (forms.length > PERSONA_MAX_ADDRESS_FORMS) {
      errors.push(`at most ${PERSONA_MAX_ADDRESS_FORMS} forms of address`);
      forms.length = PERSONA_MAX_ADDRESS_FORMS;
    }
  }

  let soul = "";
  if (raw.soul !== undefined && raw.soul !== null) {
    if (typeof raw.soul !== "string") errors.push("The Assistant's personality must be text");
    else {
      soul = raw.soul.trim();
      if (soul.length > PERSONA_SOUL_MAX_CHARS) {
        errors.push(`The Assistant's personality must be at most ${PERSONA_SOUL_MAX_CHARS} characters`);
        soul = soul.slice(0, PERSONA_SOUL_MAX_CHARS).trim();
      }
    }
  }

  return { name, address_forms: forms, soul };
}
