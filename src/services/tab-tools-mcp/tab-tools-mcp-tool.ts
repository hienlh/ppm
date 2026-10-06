import { DESIGN_CDN_HOSTS } from "../../shared/design-cdn-hosts.ts";
import { OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL } from "../../shared/tab-open-protocol.ts";

/**
 * The two tools the tab-tools MCP endpoint serves. The names each provider knows them by are
 * in `tab-open-protocol.ts`, because the chat's tool cards need them too.
 */

export {
  OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL, CLAUDE_TAB_TOOLS_MCP_SERVER, CLAUDE_OPEN_FILE_TOOL, CLAUDE_OPEN_PREVIEW_TOOL,
  CODEX_TAB_TOOLS_MCP_SERVER,
} from "../../shared/tab-open-protocol.ts";
/** Environment variable the Codex app-server reads the bearer token from. */
export const CODEX_TAB_TOOLS_MCP_TOKEN_ENV = "PPM_TAB_TOOLS_MCP_TOKEN";

/** How long a device has to say the tab is open. */
export const OPEN_FILE_WAIT_MS = 8_000;
/**
 * How long a device has to open a page, let it load and check it: the browser waits up to
 * 15 s for the load, 1.5 s for the page's scripts and up to 15 s for the check itself.
 */
export const OPEN_PREVIEW_WAIT_MS = 40_000;
/** The providers' own timeout for a call; it must exceed the longest wait above. */
export const TAB_TOOLS_TIMEOUT_MS = 60_000;

/** How a provider reaches the endpoint for one session; built by `chatService` per turn. */
export interface TabToolsMcpAccess {
  url: string;
  token: string;
}

const PATH_PROPERTY = {
  type: "string",
  description: "Absolute path, or relative to the project folder.",
};

export const OPEN_FILE_TOOL_DEFINITION = {
  name: OPEN_FILE_TOOL,
  title: "Open a file in PPM",
  description:
    "Open a file in a PPM tab on the device the user is chatting from, the way the user would open it: code in "
    + "the editor (at `line` when given), HTML, Markdown, images, PDF and CSV in PPM's viewers. Use it when the "
    + "user asks to see a file, or to point them at a place in the code. Do not open files the user did not ask "
    + "about just to read them; use your own read tools for that.",
  inputSchema: {
    type: "object",
    properties: {
      path: PATH_PROPERTY,
      line: { type: "integer", minimum: 1, description: "1-based line to show. Opens the file as code." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const OPEN_PREVIEW_TOOL_DEFINITION = {
  name: OPEN_PREVIEW_TOOL,
  title: "Show a page in PPM",
  description:
    "Show a file to the user in a PPM tab on the device they are chatting from, and check how it rendered. Use it "
    + "for anything you made for the user to look at: a page, chart, report, dashboard or mockup. Call it as soon "
    + "as the file is written: the user watches the page there while you fix it. An HTML page runs live; scripts, "
    + `styles and fonts may load from ${DESIGN_CDN_HOSTS.join(", ")}, and fetch/XHR may only reach files next to `
    + "the page. For HTML the result lists script and loading errors and layout problems, with a screenshot unless "
    + "screenshot is false; fix them and call again. That check needs no browser of your own; use one only for "
    + "what it cannot see, such as clicks or hover. Markdown, images, PDF and CSV open in PPM's viewers.",
  inputSchema: {
    type: "object",
    properties: {
      path: PATH_PROPERTY,
      screenshot: { type: "boolean", description: "Include a screenshot of an HTML page (default true)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};
