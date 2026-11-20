/**
 * The Assistant is told, as PPM's rule, to hand project work to project chats: what goes to a
 * manager chat, what to offer when a project has none, which commands run unasked and why a
 * command on "the current folder" still asks, that edits are off, and which tools to prefer.
 * Both providers get the same instruction block, so one build covers Claude and Codex. The
 * "act on its own" section appears only when the setting is on.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  ASSISTANT_ACT_ON_OWN_SECTION, ASSISTANT_DELEGATION_SECTION, ASSISTANT_OPS_SECTION,
} from "../../../src/services/assistant/assistant-instructions-ops.ts";
import {
  ASSISTANT_APPROVAL_SECTION, ASSISTANT_READ_TOOLS_SECTION, ASSISTANT_UI_SECTION, buildAssistantInstructions,
} from "../../../src/services/assistant/assistant-instructions.ts";
import { ASSISTANT_CHATS_SUBSECTIONS } from "../../../src/services/assistant/assistant-instructions-chats.ts";
import { SYSTEM_TOOLS } from "../../../src/shared/assistant-system-tool-names.ts";

const SECTIONS = [ASSISTANT_READ_TOOLS_SECTION, ASSISTANT_UI_SECTION, ASSISTANT_APPROVAL_SECTION, ASSISTANT_OPS_SECTION];
const withTools = buildAssistantInstructions({ sections: SECTIONS });
const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("hand project work to project chats", () => {
  it("is part of every turn that has the Assistant's tools, once", () => {
    expect(count(withTools, "## Hand project work to project chats")).toBe(1);
    expect(withTools).toContain(ASSISTANT_DELEGATION_SECTION);
    // A turn with no tools gets no section naming tools it does not have.
    expect(buildAssistantInstructions()).not.toContain("## Hand project work to project chats");
  });

  it("states it as PPM's rule and sends the work to the manager chat with no card", () => {
    expect(ASSISTANT_DELEGATION_SECTION).toContain("This is PPM's rule");
    expect(ASSISTANT_DELEGATION_SECTION).toContain("send it to the project's manager chat with\n  `send_to_session` (no card)");
    expect(ASSISTANT_DELEGATION_SECTION).toContain('what "done" means');
    expect(ASSISTANT_DELEGATION_SECTION).toContain("do not ask the user to approve a command for it");
  });

  it("offers a manager chat or a one-off work chat when a project has none, without choosing", () => {
    expect(ASSISTANT_DELEGATION_SECTION).toContain("(`create_session` with `manager: true`)");
    expect(ASSISTANT_DELEGATION_SECTION).toContain("(`create_session` with the task)");
    expect(ASSISTANT_DELEGATION_SECTION.replace(/\s+/g, " ")).toContain("Each is one card, or none in Full mode. Pick only if the user already said which.");
    expect(ASSISTANT_DELEGATION_SECTION).toContain("company director's assistant");
    expect(ASSISTANT_CHATS_SUBSECTIONS).toContain('offer the choice "Hand project work to\n  project chats" describes');
  });

  it("says edits are off, including Codex's silent decline", () => {
    const flat = ASSISTANT_DELEGATION_SECTION.replace(/\s+/g, " ");
    expect(flat).toContain("there is no Edit or Write");
    expect(flat).toContain("in Codex a file change you try is declined with no message");
    expect(flat).toContain('unless a section "Acting on your own" or "Full mode" below says otherwise');
  });

  it("says which commands run unasked, and that one on the current folder always asks", () => {
    for (const s of ["only reads", "every path in it is absolute", "inside a registered project or PPM's install folder", "outside private folders"]) {
      expect(ASSISTANT_DELEGATION_SECTION).toContain(s);
    }
    expect(ASSISTANT_DELEGATION_SECTION).toContain("(`git status` with no `-C`, `ls` with no path) always asks");
    expect(ASSISTANT_DELEGATION_SECTION).toContain("`git -C <absolute path>`");
    expect(ASSISTANT_DELEGATION_SECTION).toContain("so does WebSearch");
  });

  it("names every new read tool, and warns about the shortened chat ids in the logs", () => {
    for (const tool of SYSTEM_TOOLS) expect(ASSISTANT_DELEGATION_SECTION).toContain(`\`${tool}\``);
    expect(ASSISTANT_DELEGATION_SECTION).toContain("shortens chat ids to their first 8 characters");
    expect(ASSISTANT_DELEGATION_SECTION).toContain("`chat_list_sessions` or `chats_attention`");
  });

  it("sends PPM's own settings to a Settings pane, and to the CLI only when the user asks", () => {
    expect(ASSISTANT_DELEGATION_SECTION).toContain("(`ui_run_command` or `ui_open_tab`)");
    expect(ASSISTANT_DELEGATION_SECTION).toContain("after `ppm_cli_reference` (it asks) only when the user asks you to do it");
  });

  it("says nothing about one user's projects or chats", () => {
    // PPM's rule for everyone: no project names, people or languages of a particular install.
    for (const s of ["nxsys", "pex", "Quản lý", "Vietnamese", "Victor", "hienlh"]) {
      expect(ASSISTANT_DELEGATION_SECTION).not.toContain(s);
      expect(ASSISTANT_ACT_ON_OWN_SECTION).not.toContain(s);
    }
  });
});

describe("acting on its own", () => {
  it("is added only while the setting is on, after the tool sections and before the user's text", () => {
    expect(withTools).not.toContain("## Acting on your own");
    expect(buildAssistantInstructions({ sections: SECTIONS, actOnOwn: false })).toBe(withTools);
    const on = buildAssistantInstructions({ sections: SECTIONS, actOnOwn: true, userInstructions: "Be brief." });
    expect(count(on, "## Acting on your own")).toBe(1);
    expect(on.indexOf("## Acting on your own")).toBeGreaterThan(on.indexOf("## Git, schedules and tunnels"));
    expect(on.indexOf("## Acting on your own")).toBeLessThan(on.indexOf("## The user's own instructions"));
  });

  it("limits it to turns the user started and keeps PPM's own cards", () => {
    expect(ASSISTANT_ACT_ON_OWN_SECTION).toContain("In a turn the user started");
    expect(ASSISTANT_ACT_ON_OWN_SECTION).toContain("does not apply in a turn\nPPM started");
    expect(ASSISTANT_ACT_ON_OWN_SECTION).toContain("PPM's own cards (database\nchanges, git, messages to chats) and private folders still ask");
    expect(ASSISTANT_ACT_ON_OWN_SECTION).toContain("Edit and Write are offered from your\nsession's next start");
    expect(ASSISTANT_ACT_ON_OWN_SECTION).toContain("hand anything longer than a few commands");
  });
});
