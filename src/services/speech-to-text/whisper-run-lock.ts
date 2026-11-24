/**
 * One whisper-cli at a time, and nothing replaces or deletes the install while one runs.
 *
 * Transcriptions, the GPU probe and the build swap all go through here. Two runs at once would
 * each load the model and fight for the same cores (or the same GPU memory); and on Windows a
 * running `whisper-cli.exe` cannot be deleted, so swapping or removing `bin/` under it fails
 * halfway and leaves the install broken.
 */
let queue: Promise<unknown> = Promise.resolve();
let busy = 0;

/** Run `fn` after every earlier holder has finished. A failure never blocks the next one. */
export function withWhisperLock<T>(fn: () => Promise<T>): Promise<T> {
  busy++;
  const run = queue.then(fn).finally(() => { busy--; });
  queue = run.catch(() => {});
  return run;
}

/** Whether anything holds or waits for the lock — what uninstall refuses to cut under. */
export function whisperBusy(): boolean {
  return busy > 0;
}
