/**
 * Where a project's file list is searched: in the browser, or on the server where it is held.
 *
 * Shared because both ends act on the same number: the browser asks for the list only up to it,
 * and the index worker keeps a list that long ready to search.
 */

/**
 * From this many entries a list is searched on the server instead of being sent to the browser.
 * nxsys-workspace's 175k entries are a 22 MB download that took 39 ms to parse and 19–85 ms per
 * keystroke to search on a desktop, measured in Bun — several times that on a phone. Below it
 * the list is sent once and searched locally, with no round trip per keystroke.
 */
export const REMOTE_FILE_SEARCH_FROM_ENTRIES = 50_000;

/** How many ranked entries a server-side search sends back; the palette shows 100. */
export const REMOTE_FILE_SEARCH_LIMIT = 100;
