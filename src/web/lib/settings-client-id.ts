import { uuidV4 } from "@/lib/device-id";

/**
 * This page, in the settings writes it makes (`SETTINGS_CLIENT_HEADER`) and so in the
 * `settings:changed` the server announces for them: the page skips that echo, because it already
 * shows its own change, and reading it back while its next change is in flight would undo that one.
 */
export const SETTINGS_CLIENT_ID = uuidV4();
