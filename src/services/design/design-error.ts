/**
 * A refusal the design services decided themselves, carrying the HTTP status the route
 * answers with. `mapFsError` already honours a numeric `status`, so a route can hand every
 * failure to it and still tell "your request was wrong" from "the disk failed".
 */
export class DesignError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DesignError";
  }
}

export function isDesignError(e: unknown): e is DesignError {
  return e instanceof DesignError;
}
