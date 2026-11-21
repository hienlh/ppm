import {
  SETTINGS_GET_TOOL, SETTINGS_HISTORY_TOOL, SETTINGS_INSTALL_STATUS_TOOL, SETTINGS_INSTALL_TOOL, SETTINGS_SET_TOOL, SETTINGS_UNDO_TOOL,
} from "../../shared/assistant-settings-tool-names.ts";
import type { AssistantToolDefinition } from "../assistant-mcp/assistant-tool-family.ts";

/**
 * How the settings tools are described to the agent, in the order of `SETTINGS_TOOLS`.
 * Definitions only, so the tool list is built without loading the catalog (handlers:
 * `settings-tools.ts`).
 */

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const COMPONENT = {
  type: "string", enum: ["whisper", "language_server", "database_driver", "webrtc_relay"],
  description: "whisper: speech to text for voice messages. language_server: one editor language server. database_driver: MySQL/MariaDB or SSH tunnel support. webrtc_relay: Remote Desktop's relay.",
};

export const SETTINGS_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [
  {
    name: SETTINGS_GET_TOOL,
    title: "Read PPM's settings",
    description: "Read PPM's own Settings. With no arguments: the areas (Settings categories) and what can be installed. "
      + "With `area`: that area's settings — key, current value, the values allowed, and whether a change needs a card — "
      + "plus those the Assistant may not change and why. With `keys`: just those. A secret (a token, a key, a password) is "
      + "answered only as set or not set, never its value. Asks nothing.",
    inputSchema: object({
      area: { type: "string", description: "A Settings area id, e.g. voice, notifications, appearance, assistant, ai-provider." },
      keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 40, description: "Setting keys, as settings_get lists them." },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: SETTINGS_SET_TOOL,
    title: "Change PPM's settings",
    description: "Change one or more of PPM's settings through the Settings panes' own routes. Read the keys and allowed values "
      + "with settings_get first. In Full mode a turn the user started changes ordinary settings with no card; settings that "
      + "touch permissions, security, who can reach PPM, trusted instructions or accounts always show the user a card, and "
      + "Ask mode shows one for everything. Never put a secret in a value: tokens, keys and passwords are refused — send the "
      + "user to the field (settings_get gives its link). Every change is recorded and can be undone (settings_undo).",
    inputSchema: object({
      changes: {
        type: "array", minItems: 1, maxItems: 10,
        items: object({ key: { type: "string" }, value: { description: "The new value, of the type settings_get lists." } }, ["key", "value"]),
      },
    }, ["changes"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: SETTINGS_HISTORY_TOOL,
    title: "List the Assistant's settings changes",
    description: "The settings the Assistant changed (and installed or removed), newest first: before and after, whether a card "
      + "allowed it, and whether it can still be undone. The user sees the same list in Settings → PPM Assistant → Changes. Asks nothing.",
    inputSchema: object({
      limit: { type: "integer", minimum: 1, maximum: 50 },
      key: { type: "string", description: "Only this setting's changes." },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: SETTINGS_UNDO_TOOL,
    title: "Undo a settings change",
    description: "Put back the value a change replaced, by the `changeId` settings_set or settings_history gave. Refused when the "
      + "setting was changed again since. Asks like settings_set would for that setting.",
    inputSchema: object({ changeId: { type: "integer", minimum: 1 } }, ["changeId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: SETTINGS_INSTALL_TOOL,
    title: "Install or remove software PPM offers",
    description: "Install (or remove) what Settings installs on request: Whisper with a speech model, a language server, a "
      + "database driver, the WebRTC relay. Always shows the user a card, Full mode included, saying what is downloaded and "
      + "from where. Whisper and the relay download in the background: the answer is `installing`, the user sees the progress, "
      + "and settings_install_status reads it. Call settings_install_status first to see the options.",
    inputSchema: object({
      component: COMPONENT,
      action: { type: "string", enum: ["install", "uninstall"], description: "Default install." },
      option: { type: "string", description: "Whisper: the model id. Language server and database driver: their id." },
    }, ["component"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: SETTINGS_INSTALL_STATUS_TOOL,
    title: "Check an install",
    description: "Whether a component is installed, an install's progress, and the options it can be installed with. Asks nothing.",
    inputSchema: object({ component: COMPONENT, option: { type: "string" } }, ["component"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];
