/**
 * How many times PPM may answer a design turn with a `[Canvas check]` message on its own.
 *
 * Each automatic message starts another turn, which is checked again, so without a cap an
 * agent that cannot fix something would be kept going forever. The count belongs to the
 * user's message: two automatic rounds after it, then nothing until the user writes again.
 * A turn is the user's unless it is the one the last automatic message started.
 */

export const MAX_AUTO_CHECK_ROUNDS = 2;

export interface AutoCheckRounds {
  /** Automatic messages sent since the user's last own message. */
  rounds: number;
  /** An automatic message went out and its turn has not started yet. */
  awaitingAutoTurn: boolean;
}

export const INITIAL_AUTO_CHECK_ROUNDS: AutoCheckRounds = { rounds: 0, awaitingAutoTurn: false };

/** A turn began: ours consumes the flag, anyone else's resets the count. */
export function turnStarted(state: AutoCheckRounds): AutoCheckRounds {
  return state.awaitingAutoTurn ? { rounds: state.rounds, awaitingAutoTurn: false } : INITIAL_AUTO_CHECK_ROUNDS;
}

export function mayAutoSend(state: AutoCheckRounds): boolean {
  return state.rounds < MAX_AUTO_CHECK_ROUNDS;
}

export function autoSent(state: AutoCheckRounds): AutoCheckRounds {
  return { rounds: state.rounds + 1, awaitingAutoTurn: true };
}
