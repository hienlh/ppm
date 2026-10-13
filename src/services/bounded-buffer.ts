/** Head+tail bounded buffer — keeps the first and last 16 KB of a run's output, drops the middle. */
const HEAD_CAP = 16 * 1024;
const TAIL_CAP = 16 * 1024;

export class BoundedBuffer {
  private head = "";
  private tail = "";
  private droppedBytes = 0;

  append(chunk: string): void {
    if (this.head.length < HEAD_CAP) {
      const room = HEAD_CAP - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > TAIL_CAP) {
      this.droppedBytes += this.tail.length - TAIL_CAP;
      this.tail = this.tail.slice(-TAIL_CAP);
    }
  }

  toString(): string {
    if (!this.tail) return this.head;
    const marker = this.droppedBytes > 0 ? `\n... [truncated ${this.droppedBytes} bytes] ...\n` : "";
    return this.head + marker + this.tail;
  }
}
