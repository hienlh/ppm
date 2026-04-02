/** VSCode-compatible Disposable */
export class Disposable {
  private callOnDispose: () => void;
  private disposed = false;

  constructor(callOnDispose: () => void) {
    this.callOnDispose = callOnDispose;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.callOnDispose();
  }

  static from(...disposables: { dispose(): void }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) d.dispose();
    });
  }
}
