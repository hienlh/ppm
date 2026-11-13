/**
 * `/ws/global` event: the saved database connections changed (created, edited, deleted, imported,
 * copied or moved between folders), whoever changed them — a screen, the `ppm` CLI or the
 * Assistant. A browser answers it by reading the connection list again.
 */
export const DB_CONNECTIONS_CHANGED_EVENT = "db:connections_changed";

/** Window event the Database sidebar and the connection lists listen for. */
export const DB_CONNECTIONS_CHANGED_WINDOW_EVENT = "ppm:db-connections-changed";
