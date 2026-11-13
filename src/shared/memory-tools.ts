/**
 * The AI's memory tools, served by the tab-tools MCP server (`ppm-tabs`): search PPM's memory
 * store, read one memory, write or update one, and forget one. The store is shared by every
 * provider, so a memory one chat writes is there for the next, whichever AI runs it.
 */
export const MEMORY_SEARCH_TOOL = "memory_search";
export const MEMORY_READ_TOOL = "memory_read";
export const MEMORY_WRITE_TOOL = "memory_write";
export const MEMORY_FORGET_TOOL = "memory_forget";

export const MEMORY_TOOLS = [MEMORY_SEARCH_TOOL, MEMORY_READ_TOOL, MEMORY_WRITE_TOOL, MEMORY_FORGET_TOOL] as const;
export type MemoryTool = (typeof MEMORY_TOOLS)[number];

export const isMemoryTool = (name: string): name is MemoryTool =>
  (MEMORY_TOOLS as readonly string[]).includes(name);
