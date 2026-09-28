/**
 * Operation IDs for anything that takes longer than a request should wait for.
 *
 * Plan §5: "Các thao tác lâu trả operation ID, không giữ HTTP request chờ boot nhiều phút." A
 * cold boot is minutes; an HTTP request held that long dies to some proxy's idle timeout and the
 * client cannot tell a lost connection from a failed boot. So start returns an id and the client
 * polls — and a client that reconnects mid-boot re-attaches rather than starting a second one.
 */
export type OperationState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface Operation<T = unknown> {
  id: string;
  kind: string;
  state: OperationState;
  /** Human-readable progress, e.g. "booting (28s)". Not a percentage: boot has no honest one. */
  detail: string;
  startedAt: number;
  endedAt: number | null;
  result: T | null;
  error: string | null;
}

/** Finished operations are kept this long so a client that reconnects can still read the outcome. */
const RETAIN_FINISHED_MS = 5 * 60_000;
const MAX_OPERATIONS = 200;

const operations = new Map<string, Operation<any>>();

function sweep(): void {
  const now = Date.now();
  for (const [id, op] of operations) {
    if (op.endedAt !== null && now - op.endedAt > RETAIN_FINISHED_MS) operations.delete(id);
  }
  // Hard cap so a pathological caller cannot grow this without bound.
  while (operations.size > MAX_OPERATIONS) {
    const oldest = [...operations.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!oldest) break;
    operations.delete(oldest.id);
  }
}

export function createOperation<T>(kind: string, detail = ""): Operation<T> {
  sweep();
  const op: Operation<T> = {
    id: crypto.randomUUID(),
    kind,
    state: "pending",
    detail,
    startedAt: Date.now(),
    endedAt: null,
    result: null,
    error: null,
  };
  operations.set(op.id, op);
  return op;
}

export function getOperation(id: string): Operation | null {
  sweep();
  return operations.get(id) ?? null;
}

export function updateOperation(id: string, patch: Partial<Pick<Operation, "state" | "detail">>): void {
  const op = operations.get(id);
  if (!op) return;
  Object.assign(op, patch);
}

export function finishOperation<T>(id: string, result: T): void {
  const op = operations.get(id);
  if (!op) return;
  cancellers.delete(id);
  if (op.state === "cancelled") return;   // a cancel that landed first wins
  op.state = "succeeded";
  op.result = result;
  op.endedAt = Date.now();
}

export function failOperation(id: string, error: string): void {
  const op = operations.get(id);
  if (!op) return;
  cancellers.delete(id);
  if (op.state === "cancelled") return;
  op.state = "failed";
  op.error = error;
  op.endedAt = Date.now();
}

/** Test seam: drop everything. */
export function _resetOperations(): void {
  operations.clear();
  cancellers.clear();
}

/* ---------------------------------------------------------------------------------------------
 * Cancelling.
 *
 * An install can be cancelled where a boot cannot, so cancellation is registered per operation
 * rather than assumed: `getOperation` reports `cancellable` and the route refuses to cancel one
 * that never registered a way to stop.
 * ------------------------------------------------------------------------------------------- */

const cancellers = new Map<string, () => void>();

export function registerCanceller(id: string, cancel: () => void): void {
  if (operations.has(id)) cancellers.set(id, cancel);
}

export function isCancellable(id: string): boolean {
  return cancellers.has(id);
}

/** Returns false when the operation does not exist, has already ended, or cannot be cancelled. */
export function cancelOperation(id: string): boolean {
  const op = operations.get(id);
  const cancel = cancellers.get(id);
  if (!op || !cancel || op.endedAt !== null) return false;
  cancellers.delete(id);
  op.state = "cancelled";
  op.detail = "cancelled";
  op.endedAt = Date.now();
  try { cancel(); } catch { /* the work was already finishing */ }
  return true;
}
