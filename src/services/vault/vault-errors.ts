/** A refusal the vault's routes answer with its own status and message (never a value). */
export class VaultError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 423 = 400) {
    super(message);
  }
}
