import { describe, it, expect, afterEach } from "bun:test";
import { extensionService } from "../../../src/services/extension.service.ts";

/** The private surface these tests drive. The service is a singleton with no injectable
 *  worker, so the tests reach the lifecycle methods directly and replace `recoverWorker`
 *  on the instance to observe whether a close event asks for a rebuild. */
interface WorkerLifecycle {
  ensureWorker(): { worker: Worker };
  terminateWorker(): Promise<void>;
  recoverWorker: (reason: string) => Promise<void>;
}

const svc = extensionService as unknown as WorkerLifecycle;

function closed(worker: Worker): Promise<void> {
  return new Promise((resolve) => worker.addEventListener("close", () => resolve(), { once: true }));
}

/** The service's close listener is registered before ours, so by the time ours resolves the
 *  service has already decided; one more macrotask lets any `void recoverWorker()` start. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("extension host worker recovery", () => {
  afterEach(async () => {
    delete (svc as Partial<WorkerLifecycle>).recoverWorker;
    await svc.terminateWorker();
  });

  it("does not rebuild when the service itself terminates the worker", async () => {
    const calls: string[] = [];
    svc.recoverWorker = async (reason) => { calls.push(reason); };
    const { worker } = svc.ensureWorker();
    const done = closed(worker);
    await svc.terminateWorker();
    await done;
    await settle();
    expect(calls).toEqual([]);
  });

  it("rebuilds when the current worker exits on its own", async () => {
    const calls: string[] = [];
    svc.recoverWorker = async (reason) => { calls.push(reason); };
    const { worker } = svc.ensureWorker();
    const done = closed(worker);
    // Ends the thread without going through terminateWorker, the way an uncaught
    // exception in an extension does: the service still holds this worker.
    worker.terminate();
    await done;
    await settle();
    expect(calls).toEqual(["close"]);
  });
});
