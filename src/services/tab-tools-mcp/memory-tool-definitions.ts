import {
  MEMORY_FORGET_TOOL, MEMORY_READ_TOOL, MEMORY_SEARCH_TOOL, MEMORY_WRITE_TOOL,
} from "../../shared/memory-tools.ts";
import { MEMORY_TYPES } from "../memory/memory-types.ts";

/**
 * The memory tools as `tools/list` describes them. Each description says when to call the tool,
 * because an agent uses a tool only when it knows the moment it is for.
 */

export const DEFAULT_MEMORY_SEARCH_LIMIT = 10;
export const MAX_MEMORY_SEARCH_LIMIT = 25;
/** Characters of a memory's body one `memory_read` returns. */
export const MEMORY_READ_CHARS = 8_000;

const ID = { type: "string", description: "The memory's id, as memory_search or the chat's memory list gave it." };
const SCOPE = {
  type: "string", enum: ["project", "global"],
  description: "Which store: this project's memories, or the ones shared by every project. Omitted: this project's, then the shared one.",
};

export const MEMORY_SEARCH_TOOL_DEFINITION = {
  name: MEMORY_SEARCH_TOOL,
  title: "Search PPM memory",
  description:
    "Search the memories PPM keeps for this project and for every project, shared by Claude, Codex and Antigravity. "
    + "Call it before you start work that may repeat something learned earlier (a preference of the user, a convention, "
    + "a trap of this codebase), and when the chat's memory list says more were not listed. Answers one compact row per "
    + "memory (id, scope, source, score, name, description); read the body with memory_read.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What you are looking for, in words or by meaning." },
      scope: { type: "string", enum: ["project", "global", "all"], description: "Which store to search (default all)." },
      limit: { type: "integer", minimum: 1, maximum: MAX_MEMORY_SEARCH_LIMIT, description: `Rows to return (default ${DEFAULT_MEMORY_SEARCH_LIMIT}).` },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const MEMORY_READ_TOOL_DEFINITION = {
  name: MEMORY_READ_TOOL,
  title: "Read a PPM memory",
  description:
    "Read one memory: its frontmatter, its revision and its body. Call it when a memory's name or description in the "
    + `memory list or a search looks relevant, before acting on it. A body longer than ${MEMORY_READ_CHARS} characters `
    + "comes in parts: the answer names the offset to read the rest. Pass the revision it gives to memory_write to update the memory.",
  inputSchema: {
    type: "object",
    properties: {
      id: ID,
      scope: SCOPE,
      offset: { type: "integer", minimum: 0, description: "Character of the body to start at (default 0)." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const MEMORY_WRITE_TOOL_DEFINITION = {
  name: MEMORY_WRITE_TOOL,
  title: "Save a PPM memory",
  description:
    "Save something worth knowing in a later chat, whichever AI runs it: a preference or correction from the user, a "
    + "decision, a non-obvious fact about this project. Without an id it creates a memory (this project's by default; "
    + "scope global for what holds in every project). With an id it replaces that memory, and only at the revision "
    + "memory_read gave you. Memories copied from Claude, Codex or Antigravity cannot be changed: save a new one instead. "
    + "Credentials are replaced with [REDACTED] before the file is written.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The memory to update. Omit it to create one." },
      revision: { type: "string", description: "The revision memory_read answered; required with an id." },
      scope: SCOPE,
      name: { type: "string", description: "A short title." },
      description: { type: "string", description: "One line saying when this memory matters; it is what lists and searches show." },
      type: { type: "string", enum: [...MEMORY_TYPES], description: "user: about the user; feedback: how to work; project: about this work; reference: where to find things." },
      body: { type: "string", description: "The memory itself, in Markdown." },
    },
    required: ["name", "description", "type", "body"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const MEMORY_FORGET_TOOL_DEFINITION = {
  name: MEMORY_FORGET_TOOL,
  title: "Forget a PPM memory",
  description:
    "Archive a memory that is wrong or no longer holds, so it stops appearing in lists and searches. Call it when the "
    + "user says something you remember is no longer true. Its file is kept. Memories copied from another provider "
    + "cannot be forgotten here.",
  inputSchema: {
    type: "object",
    properties: { id: ID, scope: SCOPE },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const MEMORY_TOOL_DEFINITIONS = [
  MEMORY_SEARCH_TOOL_DEFINITION, MEMORY_READ_TOOL_DEFINITION, MEMORY_WRITE_TOOL_DEFINITION, MEMORY_FORGET_TOOL_DEFINITION,
];
